import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetTracker, ModelBudgetExhaustedError } from "../../src/budget.js";
import { createLogger } from "../../src/logger.js";
import { UsageTracker } from "../../src/models/usage-tracker.js";
import type { ExplorerInput, Observation } from "../../src/types.js";

// Hoisted so the mock factory (which vitest hoists above imports) and the
// test bodies below can share the same fake "SDK request" function --
// letting each test configure a call sequence and inspect exactly how
// many real HTTP-shaped attempts were made, without ever touching a real
// network endpoint.
const { anthropicCreateMock } = vi.hoisted(() => ({ anthropicCreateMock: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class FakeAnthropic {
      messages = { create: anthropicCreateMock };
      constructor(_opts: unknown) {
        void _opts;
      }
    },
  };
});

const { AnthropicModelProvider } = await import("../../src/models/provider-implementation.js");
const { ModelOutputInvalidError } = await import("../../src/models/provider.js");

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
    remainingModelCalls: 5,
    remainingDurationMs: 60_000,
  };
}

function anthropicTextResponse(text: string, usage: { input_tokens: number; output_tokens: number } | undefined): unknown {
  return { content: [{ type: "text", text }], ...(usage ? { usage } : {}) };
}

describe("AnthropicModelProvider request-boundary usage accounting (Phase 4 continuation)", () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset();
  });

  it("counts exactly 2 real HTTP attempts (first + repair) for an initially-invalid decision, each with its own measured token usage", async () => {
    anthropicCreateMock
      .mockResolvedValueOnce(anthropicTextResponse("not valid json at all", { input_tokens: 111, output_tokens: 22 }))
      .mockResolvedValueOnce(
        anthropicTextResponse(JSON.stringify({ candidateId: "stop", testingIntent: "done", reason: "no more candidates" }), {
          input_tokens: 55,
          output_tokens: 9,
        })
      );

    const usageTracker = new UsageTracker();
    const provider = new AnthropicModelProvider("fake-key", createLogger(), "claude-fake-model", usageTracker);

    const decision = await provider.decideNextAction(fakeExplorerInput());

    expect(decision.candidateId).toBe("stop");
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2);

    const attempts = usageTracker.getAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
    expect(attempts.map((a) => a.tokenUsage)).toEqual([
      { input: 111, output: 22 },
      { input: 55, output: 9 },
    ]);
    expect(usageTracker.summary().explorer.requests).toBe(2);
  });

  it("counts exactly 1 real HTTP attempt when the first response is already valid (no repair needed)", async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      anthropicTextResponse(JSON.stringify({ candidateId: "stop", testingIntent: "done", reason: "x" }), { input_tokens: 10, output_tokens: 2 })
    );

    const usageTracker = new UsageTracker();
    const provider = new AnthropicModelProvider("fake-key", createLogger(), "claude-fake-model", usageTracker);
    await provider.decideNextAction(fakeExplorerInput());

    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(usageTracker.summary().explorer.requests).toBe(1);
  });

  it("throws ModelOutputInvalidError after the repair also fails, still having recorded exactly 2 attempts", async () => {
    anthropicCreateMock.mockResolvedValue(anthropicTextResponse("still not valid json", undefined));

    const usageTracker = new UsageTracker();
    const provider = new AnthropicModelProvider("fake-key", createLogger(), "claude-fake-model", usageTracker);

    await expect(provider.decideNextAction(fakeExplorerInput())).rejects.toBeInstanceOf(ModelOutputInvalidError);
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2);
    expect(usageTracker.summary().explorer.requests).toBe(2);
  });

  it("forwards the supplied AbortSignal into every underlying SDK request", async () => {
    anthropicCreateMock.mockResolvedValueOnce(
      anthropicTextResponse(JSON.stringify({ candidateId: "stop", testingIntent: "done", reason: "x" }), undefined)
    );

    const controller = new AbortController();
    const provider = new AnthropicModelProvider("fake-key", createLogger(), "claude-fake-model");
    await provider.decideNextAction(fakeExplorerInput(), controller.signal);

    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    const [, options] = anthropicCreateMock.mock.calls[0] as [unknown, { signal?: AbortSignal } | undefined];
    expect(options?.signal).toBe(controller.signal);
  });

  it("a timeout-derived AbortSignal that fires actually aborts the in-flight SDK call (not just the awaiting Promise)", async () => {
    // Simulates the real Anthropic SDK's own behavior: when the signal it
    // was called with aborts, the request rejects with an AbortError --
    // this is what proves cancellation reaches the transport, not just a
    // Promise.race() that abandons the real request in the background.
    anthropicCreateMock.mockImplementation((_body: unknown, options?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });

    const controller = new AbortController();
    const provider = new AnthropicModelProvider("fake-key", createLogger(), "claude-fake-model");
    const pending = provider.decideNextAction(fakeExplorerInput(), controller.signal);

    controller.abort();

    await expect(pending).rejects.toThrow(/Aborted/);
  });

  it("MockModelProvider never records any usage (mock-only runs show zero real network requests)", async () => {
    const { MockModelProvider } = await import("../../src/models/provider-implementation.js");
    const usageTracker = new UsageTracker();
    // MockModelProvider takes no usageTracker at all -- there is no
    // construction path that could wrap it in real-request accounting.
    const provider = new MockModelProvider();
    await provider.decideNextAction(fakeExplorerInput());

    expect(usageTracker.summary().explorer.requests).toBe(0);
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });
});

function fakeBudget(maxModelCalls: number): BudgetTracker {
  return new BudgetTracker({ maxActions: 100, maxModelCalls, maxPages: 100, maxFindings: 100, maxDurationMs: 60_000, maxCriticCalls: 100 });
}

describe("AnthropicModelProvider budget enforcement at the request boundary (2026-09-14 addendum §4)", () => {
  beforeEach(() => {
    anthropicCreateMock.mockReset();
  });

  it("with maxModelCalls:1, a first-attempt-then-repair decision makes exactly 1 real request, then throws ModelBudgetExhaustedError -- never a second request, never an unhandled crash", async () => {
    anthropicCreateMock.mockResolvedValueOnce(anthropicTextResponse("not valid json at all", { input_tokens: 111, output_tokens: 22 }));

    const budget = fakeBudget(1);
    const provider = new AnthropicModelProvider("fake-key", createLogger(), "claude-fake-model", undefined, budget);

    await expect(provider.decideNextAction(fakeExplorerInput())).rejects.toBeInstanceOf(ModelBudgetExhaustedError);
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(budget.modelCalls).toBe(1);
  });

  it("with maxModelCalls:2, the same first-attempt-then-repair decision is permitted to make exactly 2 real requests and completes cleanly", async () => {
    anthropicCreateMock
      .mockResolvedValueOnce(anthropicTextResponse("not valid json at all", { input_tokens: 111, output_tokens: 22 }))
      .mockResolvedValueOnce(
        anthropicTextResponse(JSON.stringify({ candidateId: "stop", testingIntent: "done", reason: "no more candidates" }), {
          input_tokens: 55,
          output_tokens: 9,
        })
      );

    const budget = fakeBudget(2);
    const provider = new AnthropicModelProvider("fake-key", createLogger(), "claude-fake-model", undefined, budget);

    const decision = await provider.decideNextAction(fakeExplorerInput());

    expect(decision.candidateId).toBe("stop");
    expect(anthropicCreateMock).toHaveBeenCalledTimes(2);
    expect(budget.modelCalls).toBe(2);
  });

  it("refuses the very first request outright when the budget is already exhausted at entry", async () => {
    const budget = fakeBudget(0);
    const provider = new AnthropicModelProvider("fake-key", createLogger(), "claude-fake-model", undefined, budget);

    await expect(provider.decideNextAction(fakeExplorerInput())).rejects.toBeInstanceOf(ModelBudgetExhaustedError);
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it("a mock-only run consumes zero budget -- MockModelProvider never touches a supplied BudgetTracker", async () => {
    const { MockModelProvider } = await import("../../src/models/provider-implementation.js");
    const budget = fakeBudget(5);
    const provider = new MockModelProvider();
    await provider.decideNextAction(fakeExplorerInput());

    expect(budget.modelCalls).toBe(0);
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });
});
