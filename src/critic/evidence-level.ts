import type { EvidenceLevel } from "../types.js";

/**
 * Static, code-owned mapping. The Critic never chooses its own evidence
 * level -- it only ever receives one already assigned here (§21).
 */
const ORACLE_EVIDENCE_LEVEL: Record<string, EvidenceLevel> = {
  "duplicate-request": "L1",
  "ui-api-consistency": "L1",
  "requirement-rule": "L2",
  "page-error": "L3",
  "http-failure": "L3",
  "console-error": "L3",
};

/** Unknown/future oracle ids default to L3 (strong anomaly evidence, not automatic proof) rather than silently under- or over-classifying. */
export function evidenceLevelForOracle(oracleId: string): EvidenceLevel {
  return ORACLE_EVIDENCE_LEVEL[oracleId] ?? "L3";
}
