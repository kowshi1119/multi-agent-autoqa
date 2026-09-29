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
  /** Which session the check's requests used: none needed, the run's own authenticated session, a session the target had already rejected, or no usable session. */
  session?: "anonymous" | "run-session" | "expired" | "unavailable";
  /** With session "run-session": how that session was attached (apiChecks.runSessionAuth). */
  sessionAuth?: "cookie" | "observed-authorization";
  /** API checks that were sent: every declared assertion with a stable id and its outcome (first response). */
  assertionResults?: Array<{ id: string; assertion: string; expected: string; observed: string; passed: boolean }>;
  /** Observed attempts for a failing check (first request plus the confirmation, when one was sent). */
  attempts?: { total: number; failed: number };
  /** The finding's dedup key (src/reporting/dedup.ts), so a later run can recognise the same finding. */
  findingFingerprint?: string;
};

export type ChecksLedger = {
  schemaVersion: 1;
  entries: CheckLedgerEntry[];
};
