import { describe, expect, it } from "vitest";
import { selectPrerequisitePrefix } from "../../src/orchestrator/orchestrator.js";
import type { RecordedStep } from "../../src/types.js";

function step(number: number, overrides: Partial<RecordedStep> = {}): RecordedStep {
  return {
    number,
    action: { type: "click", target: { role: "button", name: `step-${number}` } },
    timestamp: new Date().toISOString(),
    outcome: "success",
    ...overrides,
  };
}

/**
 * §7b fix (2026-09-14 addendum): computePrerequisitePrefix() used to be an
 * unfiltered tail slice of ctx.recordedSteps -- it could include a step
 * whose executeAction() was blocked/failed, and had no state-coherence
 * anchor (the tail could start mid-sequence, spanning a prior cycle-reset
 * boundary). selectPrerequisitePrefix() is the pure filter+anchor+cap logic
 * factored out for direct unit testing.
 */
describe("selectPrerequisitePrefix (2026-09-14 addendum §7b)", () => {
  it("returns undefined for an empty history", () => {
    expect(selectPrerequisitePrefix([])).toBeUndefined();
  });

  it("excludes a blocked step from the resulting prefix", () => {
    const steps = [
      step(1, { action: { type: "navigate", url: "http://x/list" } }),
      step(2, { outcome: "blocked" }),
      step(3),
    ];

    const result = selectPrerequisitePrefix(steps);

    expect(result?.map((s) => s.number)).toEqual([1, 3]);
  });

  it("excludes an agent_action_failed step from the resulting prefix", () => {
    const steps = [
      step(1, { action: { type: "navigate", url: "http://x/list" } }),
      step(2, { outcome: "agent_action_failed" }),
      step(3),
    ];

    const result = selectPrerequisitePrefix(steps);

    expect(result?.map((s) => s.number)).toEqual([1, 3]);
  });

  it("anchors the prefix at the most recent successful navigate, excluding a stale pre-cycle-reset step before it", () => {
    const steps = [
      step(1), // stale step from a prior cycle/page, before any navigate seen here
      step(2, { action: { type: "navigate", url: "http://x/list" } }),
      step(3),
      step(4),
    ];

    const result = selectPrerequisitePrefix(steps);

    expect(result?.map((s) => s.number)).toEqual([2, 3, 4]);
  });

  it("caps the result at PREREQUISITE_PREFIX_MAX_STEPS (8), keeping the most recent steps", () => {
    const steps = [
      step(0, { action: { type: "navigate", url: "http://x/list" } }),
      ...Array.from({ length: 10 }, (_, i) => step(i + 1)),
    ];

    const result = selectPrerequisitePrefix(steps);

    expect(result?.length).toBe(8);
    expect(result?.map((s) => s.number)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("treats a step with no `outcome` field (older/mock-produced data) as successful, preserving prior behavior", () => {
    const steps = [step(1, { action: { type: "navigate", url: "http://x/list" } }), step(2, { outcome: undefined })];

    const result = selectPrerequisitePrefix(steps);

    expect(result?.map((s) => s.number)).toEqual([1, 2]);
  });

  it("returns undefined when every prior step was blocked or failed", () => {
    const steps = [step(1, { outcome: "blocked" }), step(2, { outcome: "agent_action_failed" })];

    expect(selectPrerequisitePrefix(steps)).toBeUndefined();
  });
});
