import { describe, expect, it } from "vitest";
import { estimateCostUsd, estimateRunCostUsd, PRICING_TABLE } from "../../src/models/pricing.js";
import type { UsageSummary } from "../../src/models/usage-tracker.js";

describe("estimateCostUsd / estimateRunCostUsd (Phase 4 Milestone D1)", () => {
  it("returns costUsd:null with a disclosure reason when no pricing entry exists for the model", () => {
    const usage: UsageSummary["explorer"] = { requests: 5, tokenUsage: { input: 1000, output: 200 } };
    const result = estimateCostUsd("claude-made-up-model-id", usage);
    expect(result.costUsd).toBeNull();
    if (result.costUsd === null) expect(result.reason.length).toBeGreaterThan(0);
  });

  it("returns costUsd:0 when zero requests were made, regardless of pricing table state", () => {
    const usage: UsageSummary["explorer"] = { requests: 0, tokenUsage: null };
    const result = estimateCostUsd("claude-made-up-model-id", usage);
    expect(result.costUsd).toBe(0);
  });

  it("computes a real dollar figure from an explicit, verified pricing entry with its source/date surfaced", () => {
    const testModelId = "test-model-for-pricing-unit-test";
    PRICING_TABLE[testModelId] = { source: "https://example.com/pricing (unit test fixture)", effectiveDate: "2026-01-01", inputPerMillion: 3, outputPerMillion: 15 };
    try {
      const usage: UsageSummary["explorer"] = { requests: 1, tokenUsage: { input: 1_000_000, output: 1_000_000 } };
      const result = estimateCostUsd(testModelId, usage);
      expect(result.costUsd).toBe(18); // 1M input @ $3/M + 1M output @ $15/M
      if (result.costUsd !== null) {
        expect(result.basis.source).toContain("example.com");
        expect(result.basis.effectiveDate).toBe("2026-01-01");
      }
    } finally {
      delete PRICING_TABLE[testModelId];
    }
  });

  it("returns costUsd:null when tokenUsage itself is unknown, even with a valid pricing entry", () => {
    const testModelId = "test-model-no-usage-reported";
    PRICING_TABLE[testModelId] = { source: "test", effectiveDate: "2026-01-01", inputPerMillion: 1, outputPerMillion: 1 };
    try {
      const usage: UsageSummary["explorer"] = { requests: 2, tokenUsage: null };
      const result = estimateCostUsd(testModelId, usage);
      expect(result.costUsd).toBeNull();
    } finally {
      delete PRICING_TABLE[testModelId];
    }
  });

  it("estimateRunCostUsd combines explorer+critic only when BOTH resolve to a real number", () => {
    const usage: UsageSummary = {
      explorer: { requests: 3, tokenUsage: { input: 1000, output: 100 } },
      critic: { requests: 0, tokenUsage: null },
    };
    // Explorer has no pricing entry -> unknown; critic made zero requests -> $0.
    // Combined must stay null, never silently treat the known half as the whole.
    const combined = estimateRunCostUsd("unpriced-model", "unpriced-critic-model", usage);
    expect(combined.estimatedCostUsd).toBeNull();
    expect(combined.disclosure).toContain("cannot be guaranteed");
  });

  it("PRICING_TABLE is empty by default -- no unverified rate ships as a default", () => {
    expect(Object.keys(PRICING_TABLE)).toHaveLength(0);
  });
});
