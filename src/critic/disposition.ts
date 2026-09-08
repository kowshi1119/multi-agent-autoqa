import type { CriticDecision, EvidenceLevel, FindingStatus, ReportDisposition } from "../types.js";

export type CriticOutcome =
  | { kind: "skipped" } // validationStatus !== "validated"; critic never called
  | { kind: "disabled" } // models.critic.enabled === false (Condition-A / Phase-1 parity)
  | { kind: "unavailable"; reason: string } // timeout, invalid output after repair, budget/timeout exhausted, outage
  | { kind: "contradiction"; reason: string } // CRITIC_EVIDENCE_CONTRADICTION
  | { kind: "decided"; decision: CriticDecision };

export type DispositionInput = {
  validationStatus: FindingStatus;
  evidenceLevel: EvidenceLevel;
  criticOutcome: CriticOutcome;
};

export type DispositionResult = {
  reportDisposition: ReportDisposition;
  criticEvidenceConflict: boolean;
};

/**
 * Pure policy function -- the entire disposition truth table in one place,
 * fully unit-testable without any model call or browser. §22-24, §53-55.
 */
export function decideDisposition(input: DispositionInput): DispositionResult {
  if (input.validationStatus === "rejected") {
    return { reportDisposition: "suppress", criticEvidenceConflict: false };
  }
  if (input.validationStatus === "needs_human") {
    return { reportDisposition: "needs_human", criticEvidenceConflict: false };
  }
  // validationStatus === "validated" from here on.

  if (input.criticOutcome.kind === "disabled") {
    // Old Phase-1 semantics: every validated finding is reportable. This is Experiment Condition A.
    return { reportDisposition: "report", criticEvidenceConflict: false };
  }

  if (input.criticOutcome.kind === "skipped" || input.criticOutcome.kind === "unavailable") {
    // §53: critic enabled + unavailable -> conservative default, never auto-report.
    return { reportDisposition: "needs_human", criticEvidenceConflict: false };
  }

  if (input.criticOutcome.kind === "contradiction") {
    // §24: critic's stated facts contradicted deterministic evidence.
    return { reportDisposition: "needs_human", criticEvidenceConflict: true };
  }

  // input.criticOutcome.kind === "decided"
  const { verdict } = input.criticOutcome.decision;

  if (input.evidenceLevel === "L6") {
    // §55: L6 can never be auto-elevated to "report" by any critic confidence.
    return { reportDisposition: "needs_human", criticEvidenceConflict: false };
  }

  // §54: L1 invariant + validated (which already implies >= minimumSuccesses
  // reproductions by construction of decideStatus() in validator.ts -- no
  // separate reproduction-count check is needed here) + critic says invalid
  // -> don't silently trust either side.
  if (input.evidenceLevel === "L1" && verdict === "invalid") {
    return { reportDisposition: "needs_human", criticEvidenceConflict: true };
  }

  if (verdict === "valid") return { reportDisposition: "report", criticEvidenceConflict: false };
  if (verdict === "invalid") return { reportDisposition: "suppress", criticEvidenceConflict: false };
  return { reportDisposition: "needs_human", criticEvidenceConflict: false }; // verdict === "needs_human"
}
