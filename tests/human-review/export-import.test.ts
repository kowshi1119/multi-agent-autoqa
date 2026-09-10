import { describe, expect, it } from "vitest";
import { exportForBlindReview } from "../../src/human-review/export.js";
import { computeAgreement, HumanReviewImportError, importLabels } from "../../src/human-review/import.js";
import type { HumanReviewLabel } from "../../src/human-review/types.js";
import type { GroundTruthDefect } from "../../src/reporting/benchmark.js";
import type { Finding } from "../../src/types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "FINDING-001",
    title: "New browser console error appears after form submission",
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
    evidence: ["oracle.json"],
    evidenceLevel: "L3",
    reportDisposition: "report",
    critic: { verdict: "valid", confidence: 0.9, summary: "s", provider: "mock" },
    ...overrides,
  };
}

const groundTruth: GroundTruthDefect[] = [{ id: "SEED-001", oracleId: "console-error", pathname: "/form" }];

describe("exportForBlindReview", () => {
  it("strips ground-truth id, critic verdict, and report disposition from every item", () => {
    const { export: blindExport } = exportForBlindReview([finding()]);
    const serialized = JSON.stringify(blindExport);
    expect(serialized).not.toContain("SEED-001");
    expect(serialized).not.toContain("verdict");
    expect(serialized).not.toContain("reportDisposition");
    expect(serialized).not.toContain("confidence");
  });

  it("uses an opaque itemId, not the underlying finding id", () => {
    const { export: blindExport, itemIdToFindingId } = exportForBlindReview([finding({ id: "FINDING-SECRET-001" })]);
    const item = blindExport.items[0]!;
    expect(item.itemId).not.toBe("FINDING-SECRET-001");
    expect(itemIdToFindingId[item.itemId]).toBe("FINDING-SECRET-001");
  });

  it("the mapping is a separate structure, not embedded in the export", () => {
    const { export: blindExport } = exportForBlindReview([finding()]);
    expect(JSON.stringify(blindExport)).not.toContain("itemIdToFindingId");
  });
});

describe("importLabels", () => {
  it("accepts a well-formed import", () => {
    const raw = { schemaVersion: 1, exportId: "x", labels: [{ itemId: "i1", raterId: "r1", verdict: "defect", labeledAt: "t" }] };
    expect(() => importLabels(raw)).not.toThrow();
  });

  it("rejects a label with an invalid verdict", () => {
    const raw = { schemaVersion: 1, exportId: "x", labels: [{ itemId: "i1", raterId: "r1", verdict: "maybe", labeledAt: "t" }] };
    expect(() => importLabels(raw)).toThrow(HumanReviewImportError);
  });

  it("rejects an unsupported schema version", () => {
    expect(() => importLabels({ schemaVersion: 2, exportId: "x", labels: [] })).toThrow(HumanReviewImportError);
  });
});

describe("computeAgreement", () => {
  it("returns unavailable when zero labels were imported -- never fabricates a number", () => {
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels: [] }, {}, groundTruth, {});
    expect(result).toEqual({ status: "unavailable", reason: "no independent human labels imported" });
  });

  it("returns unavailable when no imported label maps to a known item", () => {
    const labels: HumanReviewLabel[] = [{ itemId: "unknown-item", raterId: "r1", verdict: "defect", labeledAt: "t" }];
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels }, {}, groundTruth, {});
    expect(result.status).toBe("unavailable");
  });

  it("computes agreementWithGroundTruth for a correctly-labeled genuine defect", () => {
    const f = finding();
    const { export: blindExport, itemIdToFindingId } = exportForBlindReview([f]);
    const itemId = blindExport.items[0]!.itemId;
    const labels: HumanReviewLabel[] = [{ itemId, raterId: "r1", verdict: "defect", labeledAt: "t" }];
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels }, itemIdToFindingId, groundTruth, { [f.id]: f });
    expect(result).toMatchObject({ status: "computed", raterCount: 1, itemCount: 1, agreementWithGroundTruth: 1 });
  });

  it("a rater incorrectly calling a genuine defect 'not-defect' produces 0% agreement -- a valid, non-inconvenient outcome", () => {
    const f = finding();
    const { export: blindExport, itemIdToFindingId } = exportForBlindReview([f]);
    const itemId = blindExport.items[0]!.itemId;
    const labels: HumanReviewLabel[] = [{ itemId, raterId: "r1", verdict: "not-defect", labeledAt: "t" }];
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels }, itemIdToFindingId, groundTruth, { [f.id]: f });
    expect(result).toMatchObject({ status: "computed", agreementWithGroundTruth: 0 });
  });

  it("computes interRaterAgreement only when at least one item has 2+ raters", () => {
    const f = finding();
    const { export: blindExport, itemIdToFindingId } = exportForBlindReview([f]);
    const itemId = blindExport.items[0]!.itemId;
    const labels: HumanReviewLabel[] = [
      { itemId, raterId: "r1", verdict: "defect", labeledAt: "t" },
      { itemId, raterId: "r2", verdict: "defect", labeledAt: "t" },
    ];
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels }, itemIdToFindingId, groundTruth, { [f.id]: f });
    expect(result).toMatchObject({ status: "computed", raterCount: 2, interRaterAgreement: 1 });
  });

  it("omits interRaterAgreement (not a fabricated value) when every item has only one rater", () => {
    const f = finding();
    const { export: blindExport, itemIdToFindingId } = exportForBlindReview([f]);
    const itemId = blindExport.items[0]!.itemId;
    const labels: HumanReviewLabel[] = [{ itemId, raterId: "r1", verdict: "defect", labeledAt: "t" }];
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels }, itemIdToFindingId, groundTruth, { [f.id]: f });
    expect(result.status).toBe("computed");
    if (result.status === "computed") expect(result.interRaterAgreement).toBeUndefined();
  });
});
