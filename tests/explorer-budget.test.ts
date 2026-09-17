import { describe, expect, it } from "vitest";
import { ModelBudgetExhaustedError } from "../src/budget.js";
import { Explorer } from "../src/explorer.js";
import { createLogger } from "../src/logger.js";
import type { ExplorerProvider } from "../src/models/provider.js";
import type { ExplorerInput, ExplorerDecision, Observation } from "../src/types.js";

function fakeObservation(): Observation {
  return {
    timestamp: new Date().toISOString(),
    page: { url: "http://localhost/", title: "t", pathname: "/" },
    viewport: { width: 1024, height: 768 },
    visibleText: "hello",
    interactiveElements: [],
    forms: [],
    links: [],
    consoleMessages: [],
    pageErrors: [],
    networkRequests: [],
    dialogs: [],
    stateSignature: "sig",
  };
}

function fakeExplorerInput(): ExplorerInput {
  return {
    observation: fakeObservation(),
    candidates: [],
    recentActions: [],
    remainingActions: 5,
    remainingModelCalls: 0,
    remainingDurationMs: 60_000,
  };
}

/**
 * §4 fix (2026-09-14 addendum): a real provider now throws
 * ModelBudgetExhaustedError from its own complete() boundary when a
 * request would exceed the budget (e.g. a first-attempt-then-repair
 * decision where the repair would be the second real request over a
 * maxModelCalls:1 limit). Explorer.decide() must convert that into a
 * clean stop outcome, not let it escape as an unhandled crash.
 */
describe("Explorer.decide() converts a provider's ModelBudgetExhaustedError into a clean stop (2026-09-14 addendum §4)", () => {
  it("returns a stop outcome, never throwing, when the provider's complete() boundary refuses the request", async () => {
    const provider: ExplorerProvider = {
      name: "fake",
      decideNextAction(): Promise<ExplorerDecision> {
        return Promise.reject(new ModelBudgetExhaustedError("BUDGET_EXHAUSTED: maxModelCalls reached"));
      },
    };
    const explorer = new Explorer(provider, createLogger());

    const outcome = await explorer.decide(fakeExplorerInput());

    expect(outcome.kind).toBe("stop");
    if (outcome.kind === "stop") {
      expect(outcome.stopReason.type).toBe("model_requested_stop");
      if (outcome.stopReason.type === "model_requested_stop") {
        expect(outcome.stopReason.reason).toContain("BUDGET_EXHAUSTED");
      }
    }
  });

  it("still propagates any other unexpected error (not silently swallowed)", async () => {
    const provider: ExplorerProvider = {
      name: "fake",
      decideNextAction(): Promise<ExplorerDecision> {
        return Promise.reject(new Error("some unrelated network error"));
      },
    };
    const explorer = new Explorer(provider, createLogger());

    await expect(explorer.decide(fakeExplorerInput())).rejects.toThrow("some unrelated network error");
  });
});
