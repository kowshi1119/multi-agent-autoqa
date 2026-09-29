import { z } from "zod";

/**
 * Shared, machine-readable outcome vocabulary for workflow, API and security
 * execution. Release decisions, comparisons, coverage and CLI output are
 * derived from these codes only; explanations are for people and may be
 * reworded freely without changing any decision.
 *
 * Version history of the artifacts that carry these codes:
 *  - ledger/suite schemaVersion 1 (Phase 8–11): no reason codes. Read through
 *    `legacyReasonCode()`; anything that cannot be classified structurally is
 *    `legacy-unknown` (a coverage gap), never guessed as pass or failure.
 *  - schemaVersion 2 (Phase 12): every non-passing result carries a code.
 */
export const REASON_CODES = [
  "ok",
  "assertion-failed",
  "auth-failed",
  "session-expired",
  "auth-unsupported",
  "scope-rejected",
  "not-authorized",
  "cancelled",
  "budget-exhausted",
  "missing-configuration",
  "transport-error",
  "bounds-exceeded",
  "malformed-response",
  "unsupported-validation",
  "control-not-found",
  "policy-blocked",
  "reset-failed",
  "precondition-failed",
  "not-reached",
  "not-applicable",
  "internal-error",
  "legacy-unknown",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export const reasonCodeSchema = z.enum(REASON_CODES);

/** What happened to an item as a whole. */
export type ExecutionStatus = "executed" | "not-executed" | "unsupported";
/** The verdict of one assertion. `not-assessed` is never a pass. */
export type AssertionVerdict = "pass" | "fail" | "unsupported" | "not-assessed";

/**
 * Codes meaning "this capability is not available here" (a configuration
 * or support limit) as opposed to "this should have run but did not".
 * Both are coverage gaps; the split only changes wording and grouping.
 */
const UNSUPPORTED_CODES = new Set<ReasonCode>(["auth-unsupported", "scope-rejected", "not-authorized", "missing-configuration", "unsupported-validation"]);

export function executionFor(code: ReasonCode): ExecutionStatus {
  if (code === "ok" || code === "assertion-failed" || code === "malformed-response") return "executed";
  return UNSUPPORTED_CODES.has(code) ? "unsupported" : "not-executed";
}

/** Plain-language labels for codes; display only. */
export const REASON_LABELS: Record<ReasonCode, string> = {
  "ok": "Executed",
  "assertion-failed": "Assertion failed",
  "auth-failed": "Authentication failed or no authenticated session",
  "session-expired": "Session expired",
  "auth-unsupported": "Authentication mechanism unsupported for this request",
  "scope-rejected": "Outside the approved scope",
  "not-authorized": "Not authorized by the profile (e.g. a mutation)",
  "cancelled": "Cancelled",
  "budget-exhausted": "Budget exhausted",
  "missing-configuration": "Missing configuration",
  "transport-error": "Transport error",
  "bounds-exceeded": "Size or work bound exceeded",
  "malformed-response": "Malformed response",
  "unsupported-validation": "Validation not supported",
  "control-not-found": "Declared control not found",
  "policy-blocked": "Blocked by the safety policy",
  "reset-failed": "Starting state unknown (reset failed)",
  "precondition-failed": "Starting precondition not met",
  "not-reached": "Not reached before the run ended",
  "not-applicable": "Not applicable in this context",
  "internal-error": "Internal error",
  "legacy-unknown": "Recorded by an older version without a structured reason",
};

/** Workflow records already carry a structured `failureKind` (Phase 10+). */
export function reasonForWorkflowFailureKind(kind: string | null | undefined): ReasonCode {
  switch (kind) {
    case "application-assertion": return "assertion-failed";
    case "autoqa-control": return "control-not-found";
    case "session-expired": return "session-expired";
    case "policy": return "policy-blocked";
    case "reset": return "reset-failed";
    case "cancelled": return "cancelled";
    case "budget": return "budget-exhausted";
    case "precondition": return "precondition-failed";
    case "not-reached": return "not-reached";
    case "unsupported": return "missing-configuration";
    default: return "legacy-unknown";
  }
}

/**
 * Compatibility reader for schemaVersion 1 check ledger entries, which have
 * only a classification and free text. Only structural fields are used:
 * a recorded pass or recorded failing classification is kept; anything
 * that did not run is `legacy-unknown` rather than inferred from wording.
 */
export function legacyReasonCode(entry: { ran: boolean; classification: string }): ReasonCode {
  if (entry.ran && entry.classification === "passed") return "ok";
  if (entry.ran && entry.classification === "informational") return "ok";
  if (entry.ran && (entry.classification === "confirmed" || entry.classification === "needs_review")) return "assertion-failed";
  return "legacy-unknown";
}

export const assertionOutcomeSchema = z.object({
  id: z.string().min(1).max(200),
  assertion: z.string().max(500),
  expected: z.string().max(1000),
  observed: z.string().max(1000),
  verdict: z.enum(["pass", "fail", "unsupported", "not-assessed"]),
  reasonCode: reasonCodeSchema.optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  limitations: z.string().max(1000).optional(),
  severityRationale: z.string().max(1000).optional(),
  evidenceRefs: z.array(z.string().max(300)).max(20).optional(),
});
export type AssertionOutcome = z.infer<typeof assertionOutcomeSchema>;

/** The item-level result a set of assertion verdicts supports, independent of any wording. */
export function itemVerdict(verdicts: AssertionVerdict[]): "passed" | "failed" | "partially-assessed" | "unsupported" | "not-assessed" {
  if (!verdicts.length) return "not-assessed";
  if (verdicts.includes("fail")) return "failed";
  if (verdicts.every((v) => v === "pass")) return "passed";
  if (verdicts.some((v) => v === "pass")) return "partially-assessed";
  if (verdicts.every((v) => v === "unsupported")) return "unsupported";
  return "not-assessed";
}
