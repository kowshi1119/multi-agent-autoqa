import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../redact.js";

export type TriageVerdict = "defect" | "expected-behavior" | "unsure";

export type TriageLabel = {
  findingId: string;
  verdict: TriageVerdict;
  notes?: string;
  labeledAt: string;
};

export type TriageFile = {
  schemaVersion: 1;
  labels: TriageLabel[];
};

const VALID_VERDICTS = new Set<TriageVerdict>(["defect", "expected-behavior", "unsure"]);

export class TriageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageError";
  }
}

function triagePath(runDir: string): string {
  return join(runDir, "triage.json");
}

/**
 * Ordinary (non-blind) manual triage labels -- append-only alongside a
 * run's machine-decided findings, never mutating finding.json/report.json
 * (Phase 4 Milestone D2: "preserve original benchmark results"). Distinct
 * from the blind-review pipeline (src/human-review/export.ts/import.ts):
 * this is the ordinary triage view's per-card annotation, shown alongside
 * the machine's own verdict, not hidden from it.
 */
export function loadTriage(runDir: string): TriageFile {
  const path = triagePath(runDir);
  if (!existsSync(path)) return { schemaVersion: 1, labels: [] };
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as TriageFile;
  return parsed;
}

export function saveTriageLabel(runDir: string, findingId: string, verdict: TriageVerdict, notes?: string): TriageFile {
  if (!VALID_VERDICTS.has(verdict)) {
    throw new TriageError(`TRIAGE_ERROR: invalid verdict "${verdict}"`);
  }
  const file = loadTriage(runDir);
  const label: TriageLabel = { findingId, verdict, ...(notes ? { notes } : {}), labeledAt: new Date().toISOString() };
  // One label per finding -- a re-triage replaces the prior label for
  // that finding (an explicit correction), rather than accumulating an
  // unbounded history of every past click.
  const withoutPrior = file.labels.filter((l) => l.findingId !== findingId);
  const updated: TriageFile = { schemaVersion: 1, labels: [...withoutPrior, label] };
  mkdirSync(runDir, { recursive: true });
  writeFileSync(triagePath(runDir), redactSecrets(JSON.stringify(updated, null, 2)), "utf-8");
  return updated;
}
