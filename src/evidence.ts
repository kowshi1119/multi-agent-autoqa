import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { redactSecrets } from "./redact.js";
import type { CriticArtifact, ConsoleRecord, EvidenceCompleteness, NetworkRecord, OracleResult, PageErrorRecord } from "./types.js";
import type { ValidationAttemptResult } from "./validator.js";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(dir: string, filename: string, data: unknown): string {
  writeFileSync(join(dir, filename), redactSecrets(JSON.stringify(data, null, 2)), "utf-8");
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
  }
): EvidenceWriteResult {
  ensureDir(evidenceDir);

  const filenames: string[] = [];
  const skipped: string[] = [];

  filenames.push(writeJson(evidenceDir, "oracle.json", input.oracle));
  filenames.push(
    writeJson(evidenceDir, "reproduction.json", {
      attempts: input.reproduction.attempts,
      successes: input.reproduction.successes,
      results: input.attempts,
      representativeAttempt: input.representativeAttempt,
      evidenceCompleteness: input.evidenceCompleteness,
    })
  );
  filenames.push(writeJson(evidenceDir, "visible-text.json", { excerpt: input.visibleTextExcerpt }));

  if (config.evidence.console) {
    filenames.push(writeJson(evidenceDir, "console.json", input.consoleMessages));
  } else {
    skipped.push("console.json (disabled by evidence.console: false)");
  }

  if (config.evidence.network) {
    filenames.push(writeJson(evidenceDir, "network.json", input.networkRequests));
  } else {
    skipped.push("network.json (disabled by evidence.network: false)");
  }

  filenames.push(writeJson(evidenceDir, "page-errors.json", input.pageErrors));

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
 * Written only when the critic actually reached a decision (never for
 * disabled/unavailable/contradiction outcomes -- those have no real
 * decision to persist, and are already captured in finding.critic.summary).
 * Never contains hidden reasoning -- only the same structured fields as
 * CriticDecision plus provider/model.
 */
export function writeCriticArtifact(evidenceDir: string, artifact: CriticArtifact): string {
  ensureDir(evidenceDir);
  return writeJson(evidenceDir, "critic.json", artifact);
}
