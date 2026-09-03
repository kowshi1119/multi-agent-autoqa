import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { ConsoleRecord, NetworkRecord, OracleResult } from "./types.js";
import type { ValidationAttemptResult } from "./validator.js";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(dir: string, filename: string, data: unknown): string {
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2), "utf-8");
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
    consoleMessages: ConsoleRecord[];
    networkRequests: NetworkRecord[];
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
    })
  );

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
