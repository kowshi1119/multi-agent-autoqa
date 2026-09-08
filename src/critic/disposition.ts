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
 *
 * Phase 3 fix: L6 (AI-suspicion-only) is an evidence-strength CEILING, not
 * just a rule inside the "decided" branch. Before this fix, a validated
 * finding with evidenceLevel:"L6" and criticOutcome:{kind:"disabled"} hit
 * the "disabled" early-return (old code, below) and returned "report" --
 * the L6 guard was structurally unreachable for any outcome kind other
 * than "decided". Fixed by computing the per-outcome-kind disposition
 * first (decideDispositionForValidated), then applying the L6 ceiling to
 * its *result* -- this covers every outcome kind uniformly and preserves
 * whatever criticEvidenceConflict value that branch already computed
 * (e.g. L6+contradiction still correctly reports conflict:true, instead
 * of a naive top-level "if L6 return needs_human" silently discarding it).
 */
export function decideDisposition(input: DispositionInput): DispositionResult {
  if (input.validationStatus === "rejected") {
    return { reportDisposition: "suppress", criticEvidenceConflict: false };
  }
  if (input.validationStatus === "needs_human") {
    return { reportDisposition: "needs_human", criticEvidenceConflict: false };
  }
  // validationStatus === "validated" from here on.

  const result = decideDispositionForValidated(input.evidenceLevel, input.criticOutcome);

  // §55: L6 can never be auto-elevated to "report" by ANY critic outcome
  // kind -- not just "decided". Every other outcome kind's own
  // disposition (needs_human, or needs_human+conflict for contradiction)
  // already satisfies "never silently promoted", so this only needs to
  // intercept an actual "report" result.
  if (input.evidenceLevel === "L6" && result.reportDisposition === "report") {
    return { reportDisposition: "needs_human", criticEvidenceConflict: result.criticEvidenceConflict };
  }
  return result;
}

function decideDispositionForValidated(evidenceLevel: EvidenceLevel, criticOutcome: CriticOutcome): DispositionResult {
  if (criticOutcome.kind === "disabled") {
    // Old Phase-1 semantics: every validated finding is reportable. This is Experiment Condition A.
    return { reportDisposition: "report", criticEvidenceConflict: false };
  }

  if (criticOutcome.kind === "skipped" || criticOutcome.kind === "unavailable") {
    // §53: critic enabled + unavailable -> conservative default, never auto-report.
    return { reportDisposition: "needs_human", criticEvidenceConflict: false };
  }

  if (criticOutcome.kind === "contradiction") {
    // §24: critic's stated facts contradicted deterministic evidence.
    return { reportDisposition: "needs_human", criticEvidenceConflict: true };
  }

  // criticOutcome.kind === "decided"
  const { verdict } = criticOutcome.decision;

  // §54: L1 invariant + validated (which already implies >= minimumSuccesses
  // reproductions by construction of decideStatus() in validator.ts -- no
  // separate reproduction-count check is needed here) + critic says invalid
  // -> don't silently trust either side.
  if (evidenceLevel === "L1" && verdict === "invalid") {
    return { reportDisposition: "needs_human", criticEvidenceConflict: true };
  }

  if (verdict === "valid") return { reportDisposition: "report", criticEvidenceConflict: false };
  if (verdict === "invalid") return { reportDisposition: "suppress", criticEvidenceConflict: false };
  return { reportDisposition: "needs_human", criticEvidenceConflict: false }; // verdict === "needs_human"
}
