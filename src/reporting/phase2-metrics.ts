import type { BenchmarkResult } from "./benchmark.js";

export type Phase2Metrics = {
  /** Detection-level benchmark: VALIDATED findings, before any critic disposition is applied (Phase-1 semantics, Condition A). */
  detection: BenchmarkResult;
  /** Final-report-level benchmark: only findings with reportDisposition === "report" (Condition B, what a human would actually see). */
  finalReport: BenchmarkResult;
  /** Detection-level false positives no longer present in the final report. Never negative -- suppression can only remove, not add, false positives. */
  falsePositivesSuppressed: number;
  /** falsePositivesSuppressed / detection false positives, 0 when there were none to suppress. */
  falsePositiveReductionRate: number;
  /** detection.recall - finalReport.recall. 0 when the critic suppressed no true positive; positive when it did (a real cost worth surfacing, not hidden). */
  recallLoss: number;
};

/**
 * Reuses matchFindings() (see benchmark.ts) unchanged -- called once for
 * each level by the caller. This function only compares the two already-
 * computed results; it never re-implements or adjusts the matching logic
 * itself (the spec's explicit anti-cheating rule: the benchmark matcher is
 * shared, not tuned per level).
 */
export function computePhase2Metrics(detection: BenchmarkResult, finalReport: BenchmarkResult): Phase2Metrics {
  const falsePositivesSuppressed = detection.falsePositives.length - finalReport.falsePositives.length;
  const falsePositiveReductionRate =
    detection.falsePositives.length === 0 ? 0 : falsePositivesSuppressed / detection.falsePositives.length;
  const recallLoss = detection.recall - finalReport.recall;

  return { detection, finalReport, falsePositivesSuppressed, falsePositiveReductionRate, recallLoss };
}
