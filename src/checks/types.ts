/**
 * Every declared check (API or security) always gets exactly one of these
 * entries, whether or not it produced a Finding -- this is what prevents
 * "not tested" from silently reading as "passed" in the UI/report.
 */
export type CheckClassification = "confirmed" | "needs_review" | "informational" | "unsupported" | "passed";

export type CheckLedgerEntry = {
  checkId: string;
  kind: "api" | "security";
  ran: boolean;
  blockedReason?: string;
  classification: CheckClassification;
  assertion: string;
  observation: string;
  evidenceRefs: string[];
  findingId?: string;
};

export type ChecksLedger = {
  schemaVersion: 1;
  entries: CheckLedgerEntry[];
};
