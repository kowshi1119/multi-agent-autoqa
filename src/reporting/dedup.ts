import type { Finding } from "../types.js";

const MAX_NORMALIZED_ACTUAL_LENGTH = 200;

/** Trimmed, lowercased, truncated to 200 chars. Internal whitespace is deliberately NOT collapsed. */
export function normalizedActual(actual: string): string {
  return actual.trim().toLowerCase().slice(0, MAX_NORMALIZED_ACTUAL_LENGTH);
}

/** Pinned §25 key: oracleId|pathname|controlKey|normalizedActual. Empty controlKey when no control is associated. */
export function buildDedupKey(
  oracleId: string,
  pathname: string,
  controlKey: string,
  actual: string
): string {
  return `${oracleId}|${pathname}|${controlKey}|${normalizedActual(actual)}`;
}

export function dedupKeyForFinding(finding: Finding): string {
  return buildDedupKey(finding.oracle.oracleId, finding.pathname, finding.controlKey ?? "", finding.oracle.actual);
}

/**
 * Run-level duplicate protection (no embeddings). Returns the existing
 * Finding whose dedup key matches, if any -- the caller should increment
 * its occurrenceCount instead of creating a new Finding/evidence dir.
 */
export function findExistingFinding(findings: Finding[], candidateKey: string): Finding | undefined {
  return findings.find((finding) => dedupKeyForFinding(finding) === candidateKey);
}
