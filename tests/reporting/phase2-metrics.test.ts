import { describe, expect, it } from "vitest";
import { computePhase2Metrics } from "../../src/reporting/phase2-metrics.js";
import type { BenchmarkResult } from "../../src/reporting/benchmark.js";

function benchmark(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    matchedOn: "oracleId+pathname",
    seededDefects: 6,
    reportedValidatedFindings: 9,
    truePositives: [],
    falsePositives: [],
    falseNegatives: [],
    precision: 0,
    recall: 0,
    f1: 0,
    ...overrides,
  };
}

describe("computePhase2Metrics", () => {
  it("counts suppressed false positives as the drop between detection and final-report levels", () => {
    const detection = benchmark({ falsePositives: ["A", "B", "C"], recall: 1 });
    const finalReport = benchmark({ falsePositives: ["B"], recall: 1 });

    const result = computePhase2Metrics(detection, finalReport);

    expect(result.falsePositivesSuppressed).toBe(2);
    expect(result.falsePositiveReductionRate).toBeCloseTo(2 / 3);
    expect(result.recallLoss).toBe(0);
  });

  it("reports zero reduction rate (not NaN) when detection had no false positives", () => {
    const detection = benchmark({ falsePositives: [], recall: 1 });
    const finalReport = benchmark({ falsePositives: [], recall: 1 });

    const result = computePhase2Metrics(detection, finalReport);

    expect(result.falsePositiveReductionRate).toBe(0);
    expect(Number.isNaN(result.falsePositiveReductionRate)).toBe(false);
  });

  it("surfaces recall loss when the critic suppressed a true positive along with the false positives", () => {
    const detection = benchmark({ falsePositives: ["A"], recall: 1 });
    const finalReport = benchmark({ falsePositives: [], recall: 0.8333333333333334 });

    const result = computePhase2Metrics(detection, finalReport);

    expect(result.recallLoss).toBeCloseTo(1 - 0.8333333333333334);
  });

  it("never produces a negative falsePositivesSuppressed count for equal levels", () => {
    const level = benchmark({ falsePositives: ["A", "B"] });
    const result = computePhase2Metrics(level, level);
    expect(result.falsePositivesSuppressed).toBe(0);
  });
});
