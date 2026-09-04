import { describe, expect, it } from "vitest";
import { BudgetTracker, type BudgetLimits } from "../../src/budget.js";

const GENEROUS: BudgetLimits = {
  maxActions: 1000,
  maxModelCalls: 1000,
  maxPages: 1000,
  maxFindings: 1000,
  maxDurationMs: 1_000_000,
};

describe("BudgetTracker", () => {
  it("respects maxActions independently of other budgets", () => {
    const tracker = new BudgetTracker({ ...GENEROUS, maxActions: 2 });
    expect(tracker.canAct()).toBe(true);
    tracker.recordAction();
    expect(tracker.canAct()).toBe(true);
    tracker.recordAction();
    expect(tracker.canAct()).toBe(false);
    expect(tracker.canCallModel()).toBe(true);
  });

  it("respects maxModelCalls independently of other budgets", () => {
    const tracker = new BudgetTracker({ ...GENEROUS, maxModelCalls: 1 });
    expect(tracker.canCallModel()).toBe(true);
    tracker.recordModelCall();
    expect(tracker.canCallModel()).toBe(false);
    expect(tracker.canAct()).toBe(true);
  });

  it("respects maxPages independently of other budgets", () => {
    const tracker = new BudgetTracker({ ...GENEROUS, maxPages: 1 });
    expect(tracker.canVisitNewPage()).toBe(true);
    tracker.recordPageVisit();
    expect(tracker.canVisitNewPage()).toBe(false);
    expect(tracker.canAct()).toBe(true);
  });

  it("respects maxFindings independently of other budgets", () => {
    const tracker = new BudgetTracker({ ...GENEROUS, maxFindings: 1 });
    expect(tracker.canRecordFinding()).toBe(true);
    tracker.recordFinding();
    expect(tracker.canRecordFinding()).toBe(false);
    expect(tracker.canAct()).toBe(true);
  });

  it("respects maxDurationMs using an injected clock, not real time", () => {
    let currentTime = 0;
    const clock = () => currentTime;
    const tracker = new BudgetTracker({ ...GENEROUS, maxDurationMs: 10_000 }, clock);

    expect(tracker.isDurationExceeded()).toBe(false);
    currentTime = 9_999;
    expect(tracker.isDurationExceeded()).toBe(false);
    currentTime = 10_000;
    expect(tracker.isDurationExceeded()).toBe(true);
  });

  it("stops canAct/canCallModel/canVisitNewPage once duration is exceeded, even with counts remaining", () => {
    let currentTime = 0;
    const tracker = new BudgetTracker({ ...GENEROUS, maxDurationMs: 1000 }, () => currentTime);
    currentTime = 2000;

    expect(tracker.canAct()).toBe(false);
    expect(tracker.canCallModel()).toBe(false);
    expect(tracker.canVisitNewPage()).toBe(false);
  });

  it("snapshot reports configured limits alongside actual usage", () => {
    let currentTime = 0;
    const tracker = new BudgetTracker(GENEROUS, () => currentTime);
    currentTime = 500;
    tracker.recordAction();
    tracker.recordModelCall();
    tracker.recordPageVisit();
    tracker.recordFinding();

    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({
      ...GENEROUS,
      actionsUsed: 1,
      modelCallsUsed: 1,
      pagesUsed: 1,
      findingsUsed: 1,
      durationMs: 500,
    });
  });
});
