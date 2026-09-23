import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../redact.js";
import { redactStructuredEvidence } from "./redact-structured.js";
import type { ChecksLedger, CheckLedgerEntry } from "./types.js";

function ledgerPath(runDir: string): string {
  return join(runDir, "check-results.json");
}

/** Structured (JSON-tree-aware) redaction for check evidence -- see redact-structured.ts's own doc comment for why this differs from writeFindingEvidence()'s flat redactSecrets() pass. */
export function writeCheckEvidence(evidenceDir: string, filename: string, data: unknown, extraSecrets: readonly string[] = []): string {
  mkdirSync(evidenceDir, { recursive: true });
  const redacted = redactStructuredEvidence(data, extraSecrets);
  writeFileSync(join(evidenceDir, filename), redactSecrets(JSON.stringify(redacted, null, 2), extraSecrets), "utf-8");
  return filename;
}

/**
 * Every declared check appends exactly one entry here, always -- ran or
 * blocked, classified or not -- via appendCheckLedgerEntry() rather than a
 * single batched write, so a run that's cancelled mid-way through its
 * checks still leaves an accurate partial ledger on disk instead of none.
 */
export function appendCheckLedgerEntry(runDir: string, entry: CheckLedgerEntry, extraSecrets: readonly string[] = []): void {
  mkdirSync(runDir, { recursive: true });
  const path = ledgerPath(runDir);
  const existing: ChecksLedger = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as ChecksLedger) : { schemaVersion: 1, entries: [] };
  const updated: ChecksLedger = { schemaVersion: 1, entries: [...existing.entries, entry] };
  writeFileSync(path, redactSecrets(JSON.stringify(updated, null, 2), extraSecrets), "utf-8");
}

export function loadCheckLedger(runDir: string): ChecksLedger {
  const path = ledgerPath(runDir);
  if (!existsSync(path)) return { schemaVersion: 1, entries: [] };
  return JSON.parse(readFileSync(path, "utf-8")) as ChecksLedger;
}
