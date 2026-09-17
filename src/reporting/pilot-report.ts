import type { ProjectProfile } from "../profiles/schema.js";
import type { DeclaredWorkflowSummary } from "../pilot/workflow-manifest.js";
import type { QaReport } from "./qa-report.js";

/**
 * Real-application pilot summary (Phase 4 Milestone C). Deliberately
 * never references the fixture's separate seeded-defect answer-key file
 * in any form -- that file exists only to score the local fixture (a
 * positive control), and must never be loaded to "score" a real target
 * (per spec: a real target's findings have no answer key to compare
 * against). A dedicated security test enforces this file stays clean of
 * that answer-key file's identifier, the same way it already does for
 * src/validator.ts and the Explorer/Critic/oracle path.
 *
 * "heuristicCoverage" reuses the existing heuristicsApplicable/
 * heuristicsExecuted coverage counters. Phase 4 continuation correction:
 * this field was previously named "workflows" and its own doc comment
 * claimed a heuristic execution against a real-target profile directly
 * IS a "workflow exercised" -- confirmed overclaiming ("Do not call
 * generated heuristic combinations business-workflow coverage" is an
 * explicit, binding instruction). A heuristic candidate (e.g. "H01 on
 * field X") is not a human-meaningful named workflow (e.g. "create an
 * employee record"); no such declared-workflow manifest exists in this
 * codebase yet. Renamed and re-scoped honestly: this counts heuristic
 * candidates only, never presented as business-workflow coverage.
 */
export type PilotSummary = {
  runId: string;
  target: { url: string; profileId: string; environmentKind: string; version?: string };
  pages: { discovered: number; visited: number };
  /** Heuristic-candidate counts only -- see the type-level doc comment above. NOT business-workflow coverage. */
  heuristicCoverage: { applicable: number; executed: number };
  duration: { elapsedMs: number; maxDurationMs: number };
  findings: { reportable: number; needsReview: number; suppressed: number; notReproduced: number };
  /**
   * Without an independently labeled defect dataset for this target,
   * precision/recall/F1 are N/A, not fabricated -- this is the literal
   * spec requirement, not a placeholder to fill in later without one.
   */
  detection: { precision: "N/A"; recall: "N/A"; f1: "N/A"; reason: string };
  /**
   * Its own name, denominator, and unresolved count -- never conflated
   * with the fixture's answer-key-based precision/recall. "unavailable"
   * (no real human review performed) is the honest default; a genuine
   * `{status:"computed",...}` result requires real imported labels via
   * src/human-review/import.ts, never fabricated here.
   */
  humanAcceptance:
    | { status: "unavailable"; reason: string }
    | { status: "computed"; acceptedCount: number; reviewedCount: number; unresolvedCount: number; denominatorNote: string };
  /** "Pilot coverage refers to declared workflows and discovered pages, never total product coverage." */
  coverageNote: string;
  /** Passed through from the run's report -- distinguishes actual-model-use (real request counts) from actual-defect-discovery (the findings buckets above), per spec. */
  usage: QaReport["usage"];
  /**
   * 2026-09-15 fix: a genuine, separately-tracked declared-workflow
   * manifest (src/pilot/workflow-manifest.ts) -- `{manifestPresent:
   * false}` honestly whenever the profile has none (still the common
   * case), never conflated with `heuristicCoverage` above.
   */
  declaredWorkflows: DeclaredWorkflowSummary;
};

export function buildPilotSummary(report: QaReport, profile: ProjectProfile, declaredWorkflows?: DeclaredWorkflowSummary): PilotSummary {
  const findings = report.findings;
  const reportable = findings.filter((f) => f.reportDisposition === "report").length;
  const needsReview = findings.filter((f) => f.reportDisposition === "needs_human").length;
  const suppressed = findings.filter((f) => f.reportDisposition === "suppress").length;
  const notReproduced = findings.filter((f) => f.status === "rejected").length;

  return {
    runId: report.runId,
    target: { url: profile.target.url, profileId: profile.id, environmentKind: profile.target.environmentKind },
    pages: { discovered: report.coverage.pagesDiscovered, visited: report.coverage.pagesVisited },
    heuristicCoverage: { applicable: report.coverage.heuristicsApplicable, executed: report.coverage.heuristicsExecuted },
    duration: { elapsedMs: report.budget.durationMs, maxDurationMs: report.budget.maxDurationMs },
    findings: { reportable, needsReview, suppressed, notReproduced },
    detection: {
      precision: "N/A",
      recall: "N/A",
      f1: "N/A",
      reason: "No independently labeled defect dataset exists for this target -- unlike the local fixture (a positive control with a separate seeded-defect answer key), a real-application pilot has no answer key to score against.",
    },
    humanAcceptance: { status: "unavailable", reason: "No human review has been imported for this run yet (see npm run human-review:import)." },
    coverageNote:
      "Pilot coverage refers to the heuristic candidates applicable/executed and pages discovered for THIS run only -- never a claim of total product coverage, and never a claim of business-workflow coverage (heuristicCoverage counts heuristic candidates only). declaredWorkflows, when a manifest exists for this profile, is a separate, assertion-backed or explicitly annotated tracking of named business workflows -- still never a claim of TOTAL product coverage. Missing modules/pages are reported as unavailable, not as defects.",
    usage: report.usage,
    declaredWorkflows: declaredWorkflows ?? { manifestPresent: false },
  };
}
