import type { Logger } from "../logger.js";
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

/**
 * Phase 3 change: an unregistered oracle id is a code defect (someone
 * added an oracle without registering its evidence level), not a normal
 * runtime outcome -- it previously defaulted silently to "L3", which can
 * still reach "report" through ordinary critic agreement. Defaulting to
 * "L6" instead reuses the hard evidence-strength ceiling decideDisposition
 * already enforces (see critic/disposition.ts): an unclassified signal
 * can never be silently promoted to auto-report. Never throws -- the one
 * call site (orchestrator.ts#validateFinding) sits inside a try/catch that
 * would fail the entire run on any thrown error, too blunt a blast radius
 * for what should be a contained, conservative degrade -- so this logs a
 * diagnostic instead (via the caller's Logger when available, else
 * console.warn) and returns the conservative default.
 */
export const UNCLASSIFIED_ORACLE_EVIDENCE_LEVEL: EvidenceLevel = "L6";

export function evidenceLevelForOracle(oracleId: string, logger?: Logger): EvidenceLevel {
  const level = ORACLE_EVIDENCE_LEVEL[oracleId];
  if (level) return level;

  const message = `EVIDENCE_LEVEL_UNCLASSIFIED: oracle id "${oracleId}" has no registered evidence level; defaulting to ${UNCLASSIFIED_ORACLE_EVIDENCE_LEVEL} (conservative, never auto-reportable).`;
  if (logger) logger.warn({ oracleId }, message);
  else console.warn(message);
  return UNCLASSIFIED_ORACLE_EVIDENCE_LEVEL;
}
