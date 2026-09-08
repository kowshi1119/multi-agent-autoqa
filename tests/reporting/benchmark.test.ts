import { describe, expect, it } from "vitest";
import { matchFindings, type GroundTruthDefect } from "../../src/reporting/benchmark.js";
import type { Finding } from "../../src/types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "FINDING-001",
    title: "t",
    status: "validated",
    category: "console",
    pageId: "PAGE-001",
    url: "http://localhost:4173/form",
    pathname: "/form",
    expected: "e",
    actual: "a",
    oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" },
    steps: [],
    reproduction: { attempts: 3, successes: 3 },
    occurrenceCount: 1,
    evidence: [],
    evidenceLevel: "L1",
    reportDisposition: "report",
    ...overrides,
  };
}

const groundTruth: GroundTruthDefect[] = [
  { id: "SEED-001", oracleId: "console-error", pathname: "/form" },
  { id: "SEED-002", oracleId: "page-error", pathname: "/account" },
  { id: "SEED-003", oracleId: "http-failure", pathname: "/payment" },
];

describe("matchFindings", () => {
  it("matches a finding whose oracleId and pathname both match a ground-truth entry", () => {
    const result = matchFindings([finding()], groundTruth);
    expect(result.truePositives).toEqual([{ groundTruthId: "SEED-001", findingId: "FINDING-001" }]);
    expect(result.falsePositives).toEqual([]);
  });

  it("does not match when oracleId differs", () => {
    const f = finding({ oracle: { oracleId: "page-error", suspicious: true, expected: "e", actual: "a" } });
    const result = matchFindings([f], groundTruth);
    expect(result.truePositives).toEqual([]);
    expect(result.falsePositives).toEqual(["FINDING-001"]);
  });

  it("does not match when pathname differs", () => {
    const f = finding({ pathname: "/account" });
    const result = matchFindings([f], groundTruth);
    expect(result.truePositives).toEqual([]);
    expect(result.falsePositives).toEqual(["FINDING-001"]);
  });

  it("never matches by title, category, or heuristicId alone", () => {
    const f = finding({
      title: "New browser console error appears after form submission",
      category: "console",
      heuristicId: "H01",
      pathname: "/somewhere-else",
    });
    const result = matchFindings([f], groundTruth);
    expect(result.truePositives).toEqual([]);
  });

  it("counts a second finding matching an already-claimed ground-truth entry as a false positive", () => {
    const first = finding({ id: "FINDING-001" });
    const second = finding({ id: "FINDING-002", controlKey: "different:control" });
    const result = matchFindings([first, second], groundTruth);
    expect(result.truePositives).toEqual([{ groundTruthId: "SEED-001", findingId: "FINDING-001" }]);
    expect(result.falsePositives).toEqual(["FINDING-002"]);
  });

  it("lists unmatched ground-truth entries as false negatives", () => {
    const result = matchFindings([finding()], groundTruth);
    expect(result.falseNegatives.sort()).toEqual(["SEED-002", "SEED-003"]);
  });

  it("computes precision/recall/F1 correctly for a partial match", () => {
    const result = matchFindings([finding()], groundTruth);
    expect(result.precision).toBe(1);
    expect(result.recall).toBeCloseTo(1 / 3);
    expect(result.f1).toBeCloseTo((2 * 1 * (1 / 3)) / (1 + 1 / 3));
  });

  it("handles zero validated findings without NaN (precision 0, recall 0)", () => {
    const result = matchFindings([], groundTruth);
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.f1).toBe(0);
  });

  it("handles zero ground-truth entries without NaN (recall 0)", () => {
    const result = matchFindings([finding()], []);
    expect(result.recall).toBe(0);
    expect(Number.isNaN(result.recall)).toBe(false);
  });
});
