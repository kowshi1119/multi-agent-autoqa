import { describe, expect, it } from "vitest";
import { matchFindings } from "../../src/reporting/benchmark.js";
import { matchFindingsV2, type ChallengeGroundTruthEntry } from "../../src/reporting/benchmark-v2.js";
import type { Finding } from "../../src/types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "FINDING-001",
    title: "t",
    status: "validated",
    category: "network",
    pageId: "PAGE-001",
    url: "http://localhost:4173/form",
    pathname: "/form",
    expected: "e",
    actual: "a",
    oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a", details: { newErrors: ["Seeded QA defect"] } },
    steps: [],
    reproduction: { attempts: 3, successes: 3 },
    occurrenceCount: 1,
    evidence: ["oracle.json"],
    evidenceLevel: "L3",
    reportDisposition: "report",
    ...overrides,
  };
}

const originalFixtureGroundTruth: ChallengeGroundTruthEntry[] = [
  { id: "SEED-001", oracleId: "console-error", pathname: "/form" },
  { id: "SEED-002", oracleId: "page-error", pathname: "/account" },
  { id: "SEED-003", oracleId: "http-failure", pathname: "/payment" },
  { id: "SEED-004", oracleId: "duplicate-request", pathname: "/form" },
  { id: "SEED-005", oracleId: "console-error", pathname: "/account" },
  { id: "SEED-006", oracleId: "ui-api-consistency", pathname: "/payment" },
];

describe("matchFindingsV2 -- v1-oracle-pathname parity", () => {
  it("produces identical TP/FP/FN id sets to matchFindings() on the original fixture", () => {
    const findings = [
      finding({ id: "FINDING-001", pathname: "/form", oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" } }),
      finding({ id: "FINDING-002", pathname: "/account", oracle: { oracleId: "page-error", suspicious: true, expected: "e", actual: "a" } }),
      finding({ id: "FINDING-003", pathname: "/nowhere", oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" } }), // FP
    ];

    const v1 = matchFindings(findings, originalFixtureGroundTruth);
    const v2 = matchFindingsV2(findings, originalFixtureGroundTruth, "v1-oracle-pathname");

    expect(v2.truePositives).toEqual(v1.truePositives);
    expect(v2.falsePositives).toEqual(v1.falsePositives);
    expect(v2.falseNegatives.sort()).toEqual(v1.falseNegatives.sort());
    expect(v2.precision).toBeCloseTo(v1.precision);
    expect(v2.recall).toBeCloseTo(v1.recall);
  });

  it("never exposes a field or label named 'false positive rate'", () => {
    const result = matchFindingsV2([finding()], originalFixtureGroundTruth, "v1-oracle-pathname");
    expect(Object.keys(result).some((k) => k.toLowerCase().includes("falsepositiverate"))).toBe(false);
  });
});

describe("matchFindingsV2 -- v2-evidence-based disambiguation", () => {
  const collidingGroundTruth: ChallengeGroundTruthEntry[] = [
    { id: "CC-001", oracleId: "http-failure", pathname: "/payment", requestEndpoint: "/api/pay-fail" },
    { id: "CC-002", oracleId: "http-failure", pathname: "/payment", requestEndpoint: "/api/other-fail" },
  ];

  it("correctly assigns two distinct findings to two ground-truth entries sharing oracleId+pathname, using the endpoint to disambiguate", () => {
    const a = finding({
      id: "FINDING-001",
      pathname: "/payment",
      oracle: { oracleId: "http-failure", suspicious: true, expected: "e", actual: "a", details: { newFailures: [{ method: "POST", url: "http://localhost:4173/api/pay-fail", status: 500 }] } },
    });
    const b = finding({
      id: "FINDING-002",
      pathname: "/payment",
      oracle: { oracleId: "http-failure", suspicious: true, expected: "e", actual: "a", details: { newFailures: [{ method: "POST", url: "http://localhost:4173/api/other-fail", status: 500 }] } },
    });

    const result = matchFindingsV2([a, b], collidingGroundTruth, "v2-evidence-based");

    expect(result.truePositives).toHaveLength(2);
    expect(result.truePositives.find((m) => m.findingId === "FINDING-001")?.groundTruthId).toBe("CC-001");
    expect(result.truePositives.find((m) => m.findingId === "FINDING-002")?.groundTruthId).toBe("CC-002");
    expect(result.ambiguousMatches).toEqual([]);
  });

  it("surfaces a genuine ambiguous match rather than silently guessing when a finding's endpoint can't disambiguate", () => {
    // A ground truth pair that ALSO cannot be told apart even with the endpoint hint absent from one entry.
    const bothUnhinted: ChallengeGroundTruthEntry[] = [
      { id: "CC-001", oracleId: "console-error", pathname: "/form" },
      { id: "CC-002", oracleId: "console-error", pathname: "/form" },
    ];
    const a = finding({ id: "FINDING-001", pathname: "/form", oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a", details: { newErrors: ["some error"] } } });

    const result = matchFindingsV2([a], bothUnhinted, "v2-evidence-based");
    expect(result.ambiguousMatches).toHaveLength(1);
    expect(result.ambiguousMatches[0]?.groundTruthIds.sort()).toEqual(["CC-001", "CC-002"]);
    expect(result.truePositives).toEqual([]);
  });
});

describe("matchFindingsV2 -- additional metrics", () => {
  it("computes duplicateExcess from unique fingerprint groups among reportable findings only", () => {
    const a = finding({ id: "FINDING-001", controlKey: "x" });
    const b = finding({ id: "FINDING-002", controlKey: "y" }); // same fingerprint as a (console-error/form/same error)
    const result = matchFindingsV2([a, b], originalFixtureGroundTruth, "v1-oracle-pathname");
    expect(result.reportableFindings).toBe(2);
    expect(result.uniqueReportableGroups).toBe(1);
    expect(result.duplicateExcess).toBe(1);
  });

  it("counts intendedBehaviorSuppressionCount only for suppressed findings with a requirementConflict", () => {
    const suppressedWithReq = finding({ id: "FINDING-001", reportDisposition: "suppress", critic: { verdict: "invalid", confidence: 0.8, summary: "s", provider: "mock", requirementConflict: "REQ-001" } });
    const suppressedWithoutReq = finding({ id: "FINDING-002", reportDisposition: "suppress", critic: { verdict: "invalid", confidence: 0.8, summary: "s", provider: "mock" } });
    const result = matchFindingsV2([suppressedWithReq, suppressedWithoutReq], originalFixtureGroundTruth, "v1-oracle-pathname");
    expect(result.intendedBehaviorSuppressionCount).toBe(1);
  });

  it("counts trueDefectsLost for a suppressed finding that would have matched a ground-truth entry", () => {
    const lostDefect = finding({
      id: "FINDING-001",
      pathname: "/form",
      reportDisposition: "suppress",
      oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" },
    });
    const result = matchFindingsV2([lostDefect], originalFixtureGroundTruth, "v1-oracle-pathname");
    expect(result.trueDefectsLost).toBe(1);
  });

  it("actualRequests is null with a disclosed reason, never a fabricated 0", () => {
    const result = matchFindingsV2([finding()], originalFixtureGroundTruth, "v1-oracle-pathname");
    expect(result.actualRequests).toBeNull();
    expect(result.actualRequestsReason).toBeTruthy();
  });

  it("reproductionCounts reflects only validated findings", () => {
    const a = finding({ id: "FINDING-001", status: "validated", reproduction: { attempts: 3, successes: 2 } });
    const b = finding({ id: "FINDING-002", status: "validated", reproduction: { attempts: 3, successes: 3 } });
    const rejected = finding({ id: "FINDING-003", status: "rejected", reproduction: { attempts: 3, successes: 0 } });
    const result = matchFindingsV2([a, b, rejected], originalFixtureGroundTruth, "v1-oracle-pathname");
    expect(result.reproductionCounts).toEqual({ mean: 2.5, min: 2, max: 3 });
  });
});
