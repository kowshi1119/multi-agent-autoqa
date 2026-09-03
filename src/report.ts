import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./types.js";

export type RunSummary = {
  runId: string;
  project: string;
  target: string;
  startedAt: string;
  finishedAt: string;
  status: "completed";
  provider: string;
  actionsPerformed: number;
  modelCalls: number;
  suspectedFindings: number;
  validatedFindings: number;
  rejectedFindings: number;
  needsHuman: number;
  tokenUsage: null;
};

export function generateRunId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
    .replace("T", "-");
  return `RUN-${stamp}`;
}

export function generateFindingId(index: number): string {
  return `FINDING-${String(index).padStart(3, "0")}`;
}

const FINDING_TITLES: Record<string, string> = {
  "console-error": "New browser console error appears after form submission",
};

/**
 * Deterministic from the oracle id alone — never requires an extra model
 * call just to produce a human-readable finding title.
 */
export function buildFindingTitle(oracleId: string): string {
  return FINDING_TITLES[oracleId] ?? `Anomaly detected by oracle "${oracleId}"`;
}

const FINDING_NARRATIVES: Record<string, { expected: string; actual: string }> = {
  "console-error": {
    expected: "Submitting the form should not introduce an unexpected browser console error.",
    actual: "A new error-level console message appeared after form submission.",
  },
};

/** Human-readable narrative for the finding; the oracle's own expected/actual stays technical. */
export function buildFindingNarrative(
  oracleId: string,
  fallback: { expected: string; actual: string }
): { expected: string; actual: string } {
  return FINDING_NARRATIVES[oracleId] ?? fallback;
}

export function writeFindingJson(evidenceDir: string, finding: Finding): void {
  writeFileSync(join(evidenceDir, "finding.json"), JSON.stringify(finding, null, 2), "utf-8");
}

export function writeRunSummary(runDir: string, summary: RunSummary): void {
  writeFileSync(join(runDir, "run-summary.json"), JSON.stringify(summary, null, 2), "utf-8");
}
