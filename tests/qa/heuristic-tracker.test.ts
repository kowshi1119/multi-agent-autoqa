import { describe, expect, it } from "vitest";
import { buildHeuristicTrackingKey, hasExecuted, markExecuted } from "../../src/qa/heuristic-tracker.js";
import { createRunContext } from "../../src/orchestrator/run-context.js";

describe("buildHeuristicTrackingKey", () => {
  it("produces the exact pinned pageState|controlKey|heuristicId format", () => {
    expect(buildHeuristicTrackingKey("abc123", "textbox:Username", "H01")).toBe("abc123|textbox:Username|H01");
  });
});

describe("heuristic execution tracking", () => {
  it("reports not-executed before markExecuted and executed after", () => {
    const ctx = createRunContext("RUN-TEST", new Date(), "http://localhost:4173/");
    const key = buildHeuristicTrackingKey("state1", "textbox:Username", "H01");

    expect(hasExecuted(ctx, key)).toBe(false);
    markExecuted(ctx, key);
    expect(hasExecuted(ctx, key)).toBe(true);
  });

  it("does not suppress a different heuristic on the same page+control", () => {
    const ctx = createRunContext("RUN-TEST", new Date(), "http://localhost:4173/");
    markExecuted(ctx, buildHeuristicTrackingKey("state1", "textbox:Username", "H01"));

    expect(hasExecuted(ctx, buildHeuristicTrackingKey("state1", "textbox:Username", "H02"))).toBe(false);
  });

  it("marking the same key twice does not change the tracked-set size", () => {
    const ctx = createRunContext("RUN-TEST", new Date(), "http://localhost:4173/");
    const key = buildHeuristicTrackingKey("state1", "textbox:Username", "H01");

    markExecuted(ctx, key);
    markExecuted(ctx, key);

    expect(ctx.testedHeuristics.size).toBe(1);
  });
});
