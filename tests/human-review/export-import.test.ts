import { describe, expect, it } from "vitest";
import { exportForBlindReview } from "../../src/human-review/export.js";
import { computeAgreement, HumanReviewImportError, importLabels, validateLabelsAgainstMapping } from "../../src/human-review/import.js";
import type { HumanReviewLabel, HumanReviewMapping } from "../../src/human-review/types.js";
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
    const { export: blindExport, mapping } = exportForBlindReview([finding({ id: "FINDING-SECRET-001" })]);
    const item = blindExport.items[0]!;
    expect(item.itemId).not.toBe("FINDING-SECRET-001");
    expect(mapping.itemIdToFindingId[item.itemId]).toBe("FINDING-SECRET-001");
  });

  it("the mapping is a separate structure, not embedded in the export", () => {
    const { export: blindExport } = exportForBlindReview([finding()]);
    expect(JSON.stringify(blindExport)).not.toContain("itemIdToFindingId");
  });

  it("the mapping carries the same exportId as the export (Phase 4 Milestone D2 cross-check)", () => {
    const { export: blindExport, mapping } = exportForBlindReview([finding()]);
    expect(mapping.exportId).toBe(blindExport.exportId);
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

describe("validateLabelsAgainstMapping (Phase 4 Milestone D2)", () => {
  function setup(): { mapping: HumanReviewMapping; itemId: string } {
    const { export: blindExport, mapping } = exportForBlindReview([finding()]);
    return { mapping, itemId: blindExport.items[0]!.itemId };
  }

  it("rejects an unknown item id rather than silently dropping it", () => {
    const { mapping } = setup();
    const imported = { schemaVersion: 1 as const, exportId: mapping.exportId, labels: [{ itemId: "not-a-real-item", raterId: "r1", verdict: "defect" as const, labeledAt: "t" }] };
    expect(() => validateLabelsAgainstMapping(imported, mapping)).toThrow(HumanReviewImportError);
  });

  it("rejects a label file whose exportId does not match the mapping's exportId", () => {
    const { mapping, itemId } = setup();
    const imported = { schemaVersion: 1 as const, exportId: "a-different-export-entirely", labels: [{ itemId, raterId: "r1", verdict: "defect" as const, labeledAt: "t" }] };
    expect(() => validateLabelsAgainstMapping(imported, mapping)).toThrow(HumanReviewImportError);
  });

  it("rejects conflicting duplicate labels from the same rater on the same item", () => {
    const { mapping, itemId } = setup();
    const imported = {
      schemaVersion: 1 as const,
      exportId: mapping.exportId,
      labels: [
        { itemId, raterId: "r1", verdict: "defect" as const, labeledAt: "t1" },
        { itemId, raterId: "r1", verdict: "not-defect" as const, labeledAt: "t2" },
      ],
    };
    expect(() => validateLabelsAgainstMapping(imported, mapping)).toThrow(HumanReviewImportError);
  });

  it("allows an identical resubmission (same rater, same item, same verdict) and dedupes it to one entry", () => {
    const { mapping, itemId } = setup();
    const imported = {
      schemaVersion: 1 as const,
      exportId: mapping.exportId,
      labels: [
        { itemId, raterId: "r1", verdict: "defect" as const, labeledAt: "t1" },
        { itemId, raterId: "r1", verdict: "defect" as const, labeledAt: "t2" },
      ],
    };
    const { dedupedLabels } = validateLabelsAgainstMapping(imported, mapping);
    expect(dedupedLabels).toHaveLength(1);
  });

  it("a repeat submission by one rater does not inflate the independent rater count", () => {
    const { mapping, itemId } = setup();
    const imported = {
      schemaVersion: 1 as const,
      exportId: mapping.exportId,
      labels: [
        { itemId, raterId: "r1", verdict: "defect" as const, labeledAt: "t1" },
        { itemId, raterId: "r1", verdict: "defect" as const, labeledAt: "t2" },
      ],
    };
    const { dedupedLabels } = validateLabelsAgainstMapping(imported, mapping);
    const result = computeAgreement({ schemaVersion: 1, exportId: mapping.exportId, labels: dedupedLabels }, mapping.itemIdToFindingId, groundTruth, { [Object.values(mapping.itemIdToFindingId)[0] as string]: finding() });
    expect(result).toMatchObject({ raterCount: 1 });
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
    const { export: blindExport, mapping } = exportForBlindReview([f]);
    const itemId = blindExport.items[0]!.itemId;
    const labels: HumanReviewLabel[] = [{ itemId, raterId: "r1", verdict: "defect", labeledAt: "t" }];
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels }, mapping.itemIdToFindingId, groundTruth, { [f.id]: f });
    expect(result).toMatchObject({ status: "computed", raterCount: 1, itemCount: 1, agreementWithGroundTruth: 1, itemsWithVerdict: 1, abstentions: 0 });
  });

  it("a rater incorrectly calling a genuine defect 'not-defect' produces 0% agreement -- a valid, non-inconvenient outcome", () => {
    const f = finding();
    const { export: blindExport, mapping } = exportForBlindReview([f]);
    const itemId = blindExport.items[0]!.itemId;
    const labels: HumanReviewLabel[] = [{ itemId, raterId: "r1", verdict: "not-defect", labeledAt: "t" }];
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels }, mapping.itemIdToFindingId, groundTruth, { [f.id]: f });
    expect(result).toMatchObject({ status: "computed", agreementWithGroundTruth: 0 });
  });

  it("computes interRaterAgreement only when at least one item has 2+ raters", () => {
    const f = finding();
    const { export: blindExport, mapping } = exportForBlindReview([f]);
    const itemId = blindExport.items[0]!.itemId;
    const labels: HumanReviewLabel[] = [
      { itemId, raterId: "r1", verdict: "defect", labeledAt: "t" },
      { itemId, raterId: "r2", verdict: "defect", labeledAt: "t" },
    ];
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels }, mapping.itemIdToFindingId, groundTruth, { [f.id]: f });
    expect(result).toMatchObject({ status: "computed", raterCount: 2, interRaterAgreement: 1 });
  });

  it("omits interRaterAgreement (not a fabricated value) when every item has only one rater", () => {
    const f = finding();
    const { export: blindExport, mapping } = exportForBlindReview([f]);
    const itemId = blindExport.items[0]!.itemId;
    const labels: HumanReviewLabel[] = [{ itemId, raterId: "r1", verdict: "defect", labeledAt: "t" }];
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels }, mapping.itemIdToFindingId, groundTruth, { [f.id]: f });
    expect(result.status).toBe("computed");
    if (result.status === "computed") expect(result.interRaterAgreement).toBeUndefined();
  });

  it("(Phase 4 Milestone D2) omits agreementWithGroundTruth entirely when no ground truth was supplied -- a distinct state from 0% agreement", () => {
    const f = finding();
    const { export: blindExport, mapping } = exportForBlindReview([f]);
    const itemId = blindExport.items[0]!.itemId;
    const labels: HumanReviewLabel[] = [{ itemId, raterId: "r1", verdict: "not-defect", labeledAt: "t" }];
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels }, mapping.itemIdToFindingId, undefined, { [f.id]: f });
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      expect(result.agreementWithGroundTruth).toBeUndefined();
      expect(result.raterCount).toBe(1);
    }
  });

  it("(Phase 4 Milestone D2) 'unsure' is preserved as an abstention -- excluded from agreementWithGroundTruth's numerator/denominator, never folded into 'not-defect'", () => {
    const f = finding();
    const { export: blindExport, mapping } = exportForBlindReview([f]);
    const itemId = blindExport.items[0]!.itemId;
    const labels: HumanReviewLabel[] = [{ itemId, raterId: "r1", verdict: "unsure", labeledAt: "t" }];
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels }, mapping.itemIdToFindingId, groundTruth, { [f.id]: f });
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      expect(result.abstentions).toBe(1);
      expect(result.itemsWithVerdict).toBe(0);
      // 0 items with a real verdict -- agreementWithGroundTruth must not be fabricated from an empty denominator.
      expect(result.agreementWithGroundTruth).toBeUndefined();
    }
  });

  it("(Phase 4 Milestone D2) a mix of defect/not-defect/unsure labels computes agreement only over the non-abstaining items", () => {
    const f1 = finding({ id: "F1" });
    const f2 = finding({ id: "F2", pathname: "/other", oracle: { oracleId: "http-failure", suspicious: true, expected: "e", actual: "a" } });
    const { export: blindExport, mapping } = exportForBlindReview([f1, f2]);
    const item1 = blindExport.items[0]!.itemId;
    const item2 = blindExport.items[1]!.itemId;
    const labels: HumanReviewLabel[] = [
      { itemId: item1, raterId: "r1", verdict: "defect", labeledAt: "t" }, // correct (f1 is a genuine defect)
      { itemId: item2, raterId: "r1", verdict: "unsure", labeledAt: "t" }, // abstains
    ];
    const result = computeAgreement({ schemaVersion: 1, exportId: "x", labels }, mapping.itemIdToFindingId, groundTruth, { [f1.id]: f1, [f2.id]: f2 });
    expect(result.status).toBe("computed");
    if (result.status === "computed") {
      expect(result.itemsWithVerdict).toBe(1);
      expect(result.abstentions).toBe(1);
      expect(result.agreementWithGroundTruth).toBe(1);
    }
  });
});
