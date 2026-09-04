import { describe, expect, it } from "vitest";
import { createRunContext } from "../../src/orchestrator/run-context.js";

describe("createRunContext", () => {
  it("starts in INITIALIZE with zeroed counters and empty collections", () => {
    const ctx = createRunContext("RUN-TEST", new Date("2026-01-01T00:00:00.000Z"), "http://localhost:4173/");

    expect(ctx.state).toBe("INITIALIZE");
    expect(ctx.currentUrl).toBe("http://localhost:4173/");
    expect(ctx.actionsPerformed).toBe(0);
    expect(ctx.modelCalls).toBe(0);
    expect(ctx.pagesVisited).toBe(0);
    expect(ctx.heuristicsExecuted).toBe(0);
    expect(ctx.findings).toEqual([]);
    expect(ctx.recordedSteps).toEqual([]);
    expect(ctx.testedHeuristics.size).toBe(0);
    expect(ctx.visitedPages.size).toBe(0);
    expect(ctx.frontier).toEqual([]);
    expect(ctx.heuristicsApplicableCount).toBe(0);
    expect(ctx.startedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
