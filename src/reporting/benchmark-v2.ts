import { fingerprintFinding, fingerprintKey } from "../grouping/fingerprint.js";
import type { Finding } from "../types.js";
import { matchFindings, type BenchmarkMatch, type GroundTruthDefect } from "./benchmark.js";

export type EvaluatorVersion = "v1-oracle-pathname" | "v2-evidence-based";

/**
 * Extends GroundTruthDefect with the extra structural facts needed to
 * disambiguate two entries that share oracleId+pathname -- only required
 * for v2-evidence-based matching on an expanded/challenge dataset; the
 * original 6-defect fixture never needs these fields and v1 parity is
 * unaffected by their presence.
 */
export type ChallengeGroundTruthEntry = GroundTruthDefect & {
  requestEndpoint?: string;
  errorSignature?: string;
};

export type AmbiguousMatch = { groundTruthIds: string[]; findingIds: string[] };

export type DuplicateAwareBenchmarkResult = {
  evaluatorVersion: EvaluatorVersion;
  rawValidatedFindings: number;
  reportableFindings: number;
  uniqueReportableGroups: number;
  duplicateExcess: number;
  truePositives: BenchmarkMatch[];
  falsePositives: string[];
  falseNegatives: string[];
  /** Standard denominators only (reportableFindings / seededDefects) -- never a "false positive rate" (that needs a defined negative-case denominator this benchmark doesn't have). */
  precision: number;
  recall: number;
  f1: number;
  /** Reportable findings matching no ground-truth defect -- same set as falsePositives, tracked under this name because it's the spec's own explicitly-labeled metric. */
  nonDefectReports: number;
  /** Suppressed findings whose critic decision cited a matched requirement (correct intended-behavior/expected-failure suppression). */
  intendedBehaviorSuppressionCount: number;
  /** Suppressed/needs_human findings that WOULD have matched a ground-truth defect not already claimed by a reportable true positive -- a genuine defect the final report lost. */
  trueDefectsLost: number;
  needsHumanCount: number;
  reproductionCounts: { mean: number; min: number; max: number };
  /** null (with a reason) rather than fabricated 0 -- usage/cost tracking isn't implemented in this build (see PROGRESS.md's A3 scoping note). */
  actualRequests: number | null;
  actualRequestsReason?: string;
  wallClockMs: number | null;
  ambiguousMatches: AmbiguousMatch[];
};

function reproductionStats(findings: Finding[]): { mean: number; min: number; max: number } {
  const successes = findings.map((f) => f.reproduction.successes);
  if (successes.length === 0) return { mean: 0, min: 0, max: 0 };
  return {
    mean: successes.reduce((a, b) => a + b, 0) / successes.length,
    min: Math.min(...successes),
    max: Math.max(...successes),
  };
}

/**
 * Evaluator-only, evidence-based benchmark. `v1-oracle-pathname` reuses
 * matchFindings() (src/reporting/benchmark.ts, never modified) verbatim
 * for exact parity with the original fixture's historical semantics.
 * `v2-evidence-based` additionally disambiguates two ground-truth entries
 * that share oracleId+pathname -- impossible to tell apart under v1 --
 * using the same structural fingerprint grouping/fingerprint.ts uses,
 * one-to-one, surfacing genuine ties as `ambiguousMatches` rather than
 * silently breaking them with array order. No evaluator label (a
 * ground-truth id, this matcher's own verdict) ever reaches a prompt or
 * a runtime grouping decision -- this module is evaluation-code only,
 * the same isolation guarantee benchmark.ts already has.
 */
export function matchFindingsV2(
  allFindings: Finding[],
  groundTruth: ChallengeGroundTruthEntry[],
  evaluatorVersion: EvaluatorVersion,
  options: { wallClockMs?: number } = {}
): DuplicateAwareBenchmarkResult {
  const validated = allFindings.filter((f) => f.status === "validated");
  const reportable = allFindings.filter((f) => f.reportDisposition === "report");
  const suppressed = allFindings.filter((f) => f.reportDisposition === "suppress");
  const needsHuman = allFindings.filter((f) => f.reportDisposition === "needs_human");

  const uniqueReportableGroups = new Set(reportable.map((f) => fingerprintKey(fingerprintFinding(f)))).size;

  const ambiguousMatches: AmbiguousMatch[] = [];
  let truePositives: BenchmarkMatch[];
  let falsePositives: string[];
  let falseNegatives: string[];

  if (evaluatorVersion === "v1-oracle-pathname") {
    const result = matchFindings(reportable, groundTruth);
    truePositives = result.truePositives;
    falsePositives = result.falsePositives;
    falseNegatives = result.falseNegatives;
  } else {
    const matchedGtIds = new Set<string>();
    truePositives = [];
    falsePositives = [];
    for (const finding of reportable) {
      const fp = fingerprintFinding(finding);
      const candidates = groundTruth.filter(
        (g) =>
          !matchedGtIds.has(g.id) &&
          g.oracleId === finding.oracle.oracleId &&
          g.pathname === finding.pathname &&
          (!g.requestEndpoint || g.requestEndpoint === fp.requestEndpoint) &&
          (!g.errorSignature || g.errorSignature === fp.errorSignature)
      );
      if (candidates.length === 0) {
        falsePositives.push(finding.id);
      } else if (candidates.length === 1) {
        matchedGtIds.add(candidates[0]!.id);
        truePositives.push({ groundTruthId: candidates[0]!.id, findingId: finding.id });
      } else {
        ambiguousMatches.push({ groundTruthIds: candidates.map((c) => c.id), findingIds: [finding.id] });
      }
    }
    falseNegatives = groundTruth.filter((g) => !matchedGtIds.has(g.id)).map((g) => g.id);
  }

  const precision = reportable.length === 0 ? 0 : truePositives.length / reportable.length;
  const recall = groundTruth.length === 0 ? 0 : truePositives.length / groundTruth.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  // trueDefectsLost: a suppressed/needs_human finding that would have
  // matched a ground-truth entry not already claimed by a reportable TP.
  const claimedByReportable = new Set(truePositives.map((m) => m.groundTruthId));
  const lostMatched = new Set<string>();
  let trueDefectsLost = 0;
  for (const finding of [...suppressed, ...needsHuman]) {
    const gt = groundTruth.find(
      (g) =>
        !claimedByReportable.has(g.id) &&
        !lostMatched.has(g.id) &&
        g.oracleId === finding.oracle.oracleId &&
        g.pathname === finding.pathname
    );
    if (gt) {
      lostMatched.add(gt.id);
      trueDefectsLost += 1;
    }
  }

  const intendedBehaviorSuppressionCount = suppressed.filter((f) => Boolean(f.critic?.requirementConflict)).length;

  return {
    evaluatorVersion,
    rawValidatedFindings: validated.length,
    reportableFindings: reportable.length,
    uniqueReportableGroups,
    duplicateExcess: reportable.length - uniqueReportableGroups,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    nonDefectReports: falsePositives.length,
    intendedBehaviorSuppressionCount,
    trueDefectsLost,
    needsHumanCount: needsHuman.length,
    reproductionCounts: reproductionStats(validated),
    actualRequests: null,
    actualRequestsReason: "usage/cost tracking not implemented in this build (see PROGRESS.md's A3 scoping note)",
    wallClockMs: options.wallClockMs ?? null,
    ambiguousMatches,
  };
}
