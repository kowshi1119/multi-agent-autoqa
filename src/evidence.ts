import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { redactSecrets } from "./redact.js";
import { assertMinimizerAllowed, guardMinimized, isMinimal, minimizeConsole, minimizeNetwork, minimizePageErrors, policyOf } from "./privacy/evidence-policy.js";
import { dirname } from "node:path";
import type { CriticArtifact, ConsoleRecord, EvidenceCompleteness, NetworkRecord, OracleResult, PageErrorRecord } from "./types.js";
import type { ValidationAttemptResult } from "./validator.js";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(dir: string, filename: string, data: unknown, extraSecrets: readonly string[] = []): string {
  writeFileSync(join(dir, filename), redactSecrets(JSON.stringify(data, null, 2), extraSecrets), "utf-8");
  return filename;
}

export type EvidenceWriteResult = {
  filenames: string[];
  skipped: string[];
};

/**
 * Writes every evidence artifact for one finding, honoring the evidence.*
 * config flags. Files that are disabled or unavailable are listed under
 * `skipped` (with the reason) rather than silently omitted.
 */
export function writeFindingEvidence(
  evidenceDir: string,
  config: AppConfig,
  input: {
    oracle: OracleResult;
    attempts: ValidationAttemptResult[];
    reproduction: { attempts: number; successes: number };
    /** Which attempt representativeEvidence below actually came from, and whether it's a genuine reproduction or a diagnostic-only snapshot -- persisted so Condition B's post-hoc reconstruction (src/phase2-experiment.ts) can rebuild the exact same CriticInput.evidence.attemptScope the live run saw. */
    representativeAttempt: number;
    evidenceCompleteness: EvidenceCompleteness;
    consoleMessages: ConsoleRecord[];
    networkRequests: NetworkRecord[];
    pageErrors: PageErrorRecord[];
    /** Persisted unconditionally (not gated by evidence.* flags): small, redacted, and needed to reconstruct a CriticInput post-hoc even when the critic never ran here (see src/phase2-experiment.ts Condition B). */
    visibleTextExcerpt: string;
    screenshotPath?: string;
    tracePath?: string;
  },
  extraSecrets: readonly string[] = []
): EvidenceWriteResult {
  ensureDir(evidenceDir);

  const filenames: string[] = [];
  const skipped: string[] = [];

  const policy = policyOf(config);
  if (isMinimal(policy)) return writeMinimalFindingEvidence(evidenceDir, config, input, extraSecrets);

  filenames.push(writeJson(evidenceDir, "oracle.json", input.oracle, extraSecrets));
  filenames.push(
    writeJson(
      evidenceDir,
      "reproduction.json",
      {
        attempts: input.reproduction.attempts,
        successes: input.reproduction.successes,
        results: input.attempts,
        representativeAttempt: input.representativeAttempt,
        evidenceCompleteness: input.evidenceCompleteness,
      },
      extraSecrets
    )
  );
  filenames.push(writeJson(evidenceDir, "visible-text.json", { excerpt: input.visibleTextExcerpt }, extraSecrets));

  if (config.evidence.console) {
    filenames.push(writeJson(evidenceDir, "console.json", input.consoleMessages, extraSecrets));
  } else {
    skipped.push("console.json (disabled by evidence.console: false)");
  }

  if (config.evidence.network) {
    filenames.push(writeJson(evidenceDir, "network.json", input.networkRequests, extraSecrets));
  } else {
    skipped.push("network.json (disabled by evidence.network: false)");
  }

  filenames.push(writeJson(evidenceDir, "page-errors.json", input.pageErrors, extraSecrets));

  if (config.evidence.screenshots) {
    if (input.screenshotPath) {
      filenames.push("screenshot.png");
    } else {
      skipped.push("screenshot.png (enabled in config but capture failed)");
    }
  } else {
    skipped.push("screenshot.png (disabled by evidence.screenshots: false)");
  }

  if (config.evidence.trace) {
    if (input.tracePath) {
      filenames.push("trace.zip");
    } else {
      skipped.push("trace.zip (enabled in config but capture failed)");
    }
  } else {
    skipped.push("trace.zip (disabled by evidence.trace: false)");
  }

  return { filenames, skipped };
}

/**
 * Minimal evidence policy (docs/privacy/EVIDENCE_POLICY.md): identities,
 * verdicts, counts and route templates only. Oracle text, visible text,
 * console and error messages and full URLs are not written; screenshots and
 * traces are not captured in this mode. Each file is built by a typed
 * minimizer; a minimizer failure writes a marker, never the raw value.
 */
function writeMinimalFindingEvidence(evidenceDir: string, config: AppConfig, input: Parameters<typeof writeFindingEvidence>[2], extraSecrets: readonly string[]): EvidenceWriteResult {
  const policy = policyOf(config);
  const runDir = dirname(dirname(evidenceDir));
  const origin = (() => { try { return new URL(config.target.url).origin; } catch { return undefined; } })();
  const write = (name: string, category: string, build: () => unknown) => writeJson(evidenceDir, name, guardMinimized(() => { assertMinimizerAllowed(category); return build(); }, category, runDir), extraSecrets);
  const filenames = [
    write("oracle.json", "finding-oracle", () => ({ oracleId: input.oracle.oracleId, suspicious: input.oracle.suspicious, omitted: "expected/actual text and details" })),
    write("reproduction.json", "finding-reproduction", () => ({
      attempts: input.reproduction.attempts,
      successes: input.reproduction.successes,
      results: input.attempts.map((a) => ({ attempt: a.attempt, reproduced: a.reproduced, oracleSuspicious: a.oracleSuspicious, oracleId: a.oracleResult.oracleId })),
      representativeAttempt: input.representativeAttempt,
      evidenceCompleteness: input.evidenceCompleteness,
      omitted: "oracle text and tooling error messages",
    })),
    ...(config.evidence.console ? [write("console.json", "finding-console", () => minimizeConsole(input.consoleMessages))] : []),
    ...(config.evidence.network ? [write("network.json", "finding-network", () => minimizeNetwork(input.networkRequests, policy, origin))] : []),
    write("page-errors.json", "finding-page-errors", () => minimizePageErrors(input.pageErrors)),
  ];
  const skipped = [
    `visible-text.json (not written under ${policy.version} minimal evidence)`,
    `screenshot.png (not captured under ${policy.version} minimal evidence)`,
    `trace.zip (not captured under ${policy.version} minimal evidence)`,
  ];
  return { filenames, skipped };
}

/**
 * Written only when the critic actually reached a decision (never for
 * disabled/unavailable/contradiction outcomes -- those have no real
 * decision to persist, and are already captured in finding.critic.summary).
 * Never contains hidden reasoning -- only the same structured fields as
 * CriticDecision plus provider/model.
 */
export function writeCriticArtifact(evidenceDir: string, artifact: CriticArtifact, extraSecrets: readonly string[] = [], config?: AppConfig): string {
  ensureDir(evidenceDir);
  // Minimal evidence: the decision's verdict and confidence, not the model's free text about the page.
  if (config && isMinimal(policyOf(config))) {
    const a = artifact as { provider: string; model?: string; verdict?: unknown; confidence?: unknown };
    return writeJson(evidenceDir, "critic.json", { provider: a.provider, ...(a.model ? { model: a.model } : {}), verdict: a.verdict, confidence: a.confidence, omitted: "summary and explanation text" }, extraSecrets);
  }
  return writeJson(evidenceDir, "critic.json", artifact, extraSecrets);
}
