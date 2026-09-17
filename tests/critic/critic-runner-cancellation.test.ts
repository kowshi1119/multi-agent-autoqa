import { describe, expect, it } from "vitest";
import { BudgetTracker, CriticBudgetExhaustedError } from "../../src/budget.js";
import { Critic, deriveTimeoutSignal } from "../../src/critic/critic-runner.js";
import { createLogger } from "../../src/logger.js";
import type { CriticProvider } from "../../src/models/critic-provider.js";
import type { CriticDecision, CriticInput, Finding } from "../../src/types.js";
import type { ValidationOutcome } from "../../src/validator.js";
import { loadTestConfig } from "../helpers/test-config.js";

function testBudget(): BudgetTracker {
  return new BudgetTracker({ maxActions: 10, maxModelCalls: 10, maxPages: 10, maxFindings: 10, maxDurationMs: 60_000, maxCriticCalls: 10 });
}

function validatedFinding(): Finding {
  return {
    id: "FINDING-CANCEL-TEST",
    title: "t",
    status: "validated",
    category: "console",
    pageId: "PAGE-1",
    url: "http://localhost/",
    pathname: "/",
    expected: "e",
    actual: "a",
    oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" },
    steps: [],
    reproduction: { attempts: 3, successes: 3 },
    occurrenceCount: 1,
    evidence: [],
    evidenceLevel: "L3",
    reportDisposition: "needs_human",
  };
}

function fakeValidationOutcome(): ValidationOutcome {
  return {
    finding: validatedFinding(),
    attempts: [],
    representativeAttempt: 1,
    evidenceCompleteness: "representative-success",
    representativeEvidence: { consoleMessages: [], networkRequests: [], pageErrors: [], visibleTextExcerpt: "" },
  };
}

describe("deriveTimeoutSignal (Phase 4 continuation cancellation fix)", () => {
  it("fires once the timeout elapses even with no external signal supplied", async () => {
    const signal = deriveTimeoutSignal(20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signal.aborted).toBe(true);
  });

  it("fires immediately when the external signal is already aborted, regardless of the timeout duration", () => {
    const controller = new AbortController();
    controller.abort();
    const signal = deriveTimeoutSignal(60_000, controller.signal);
    expect(signal.aborted).toBe(true);
  });

  it("fires when the external signal aborts before the timeout would", async () => {
    const controller = new AbortController();
    const signal = deriveTimeoutSignal(60_000, controller.signal);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("Critic.review() cancellation (Phase 4 continuation)", () => {
  it("skips the critic call entirely -- never invokes the provider -- when abortSignal is already aborted", async () => {
    let called = false;
    const fakeCriticProvider: CriticProvider = {
      name: "fake",
      // eslint-disable-next-line @typescript-eslint/require-await
      async critique(_input: CriticInput): Promise<CriticDecision> {
        called = true;
        throw new Error("must never be called once the run has been cancelled");
      },
    };

    const controller = new AbortController();
    controller.abort();

    const critic = new Critic({
      criticProvider: fakeCriticProvider,
      config: loadTestConfig((y) => y.replace("enabled: false", "enabled: true")),
      logger: createLogger(),
      requirements: [],
      budget: testBudget(),
      abortSignal: controller.signal,
    });

    const { finding } = await critic.review(validatedFinding(), fakeValidationOutcome(), "/tmp/does-not-matter");

    expect(called).toBe(false);
    expect(finding.critic?.summary).toContain("CANCELLED");
  });

  it("aborts a hanging fake critic call within a bounded time when the run's abortSignal fires mid-call, via the signal passed to critique()", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fakeCriticProvider: CriticProvider = {
      name: "fake",
      critique(_input: CriticInput, signal?: AbortSignal): Promise<CriticDecision> {
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      },
    };

    const controller = new AbortController();
    const config = loadTestConfig((y) => y.replace("enabled: false", "enabled: true").replace("providerTimeoutMs: 30000", "providerTimeoutMs: 60000"));

    const critic = new Critic({
      criticProvider: fakeCriticProvider,
      config,
      logger: createLogger(),
      requirements: [],
      budget: testBudget(),
      abortSignal: controller.signal,
    });

    const pending = critic.review(validatedFinding(), fakeValidationOutcome(), "/tmp/does-not-matter");
    // Give review() a tick to reach the critique() call before aborting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    const { finding } = await pending;
    expect(receivedSignal).toBeDefined();
    expect(finding.critic?.verdict).toBe("needs_human");
  }, 10_000);
});

describe("Critic.review() budget accounting (2026-09-14 addendum §4: diff-based fallback recording)", () => {
  it("converts a provider's CriticBudgetExhaustedError into a clean BUDGET_EXHAUSTED outcome, never crashing", async () => {
    const fakeCriticProvider: CriticProvider = {
      name: "fake",
      // eslint-disable-next-line @typescript-eslint/require-await
      async critique(): Promise<CriticDecision> {
        throw new CriticBudgetExhaustedError("BUDGET_EXHAUSTED: maxCriticCalls reached mid-decision");
      },
    };

    const critic = new Critic({
      criticProvider: fakeCriticProvider,
      config: loadTestConfig((y) => y.replace("enabled: false", "enabled: true")),
      logger: createLogger(),
      requirements: [],
      budget: testBudget(),
    });

    const { finding } = await critic.review(validatedFinding(), fakeValidationOutcome(), "/tmp/does-not-matter");

    expect(finding.critic?.verdict).toBe("needs_human");
    expect(finding.critic?.summary).toContain("BUDGET_EXHAUSTED");
  });

  it("falls back to recording exactly 1 critic call when the provider itself consumes none (mirrors MockCriticProvider, which never touches a supplied budget)", async () => {
    const fakeCriticProvider: CriticProvider = {
      name: "fake",
      // eslint-disable-next-line @typescript-eslint/require-await
      async critique(): Promise<CriticDecision> {
        return { verdict: "valid", confidence: 1, summary: "s", evidenceReferences: [], missingEvidence: [] };
      },
    };
    const budget = testBudget();

    const critic = new Critic({
      criticProvider: fakeCriticProvider,
      config: loadTestConfig((y) => y.replace("enabled: false", "enabled: true")),
      logger: createLogger(),
      requirements: [],
      budget,
    });

    await critic.review(validatedFinding(), fakeValidationOutcome(), "/tmp/does-not-matter");

    expect(budget.criticCalls).toBe(1);
  });

  it("never double-counts when the provider already recorded its own real request against the budget", async () => {
    const budget = testBudget();
    const fakeCriticProvider: CriticProvider = {
      name: "fake",
      async critique(): Promise<CriticDecision> {
        // Simulates a real provider's own complete() boundary recording
        // itself, the same way AnthropicCriticProvider/ExplabsCriticProvider
        // now do.
        budget.recordCriticCall();
        return { verdict: "valid", confidence: 1, summary: "s", evidenceReferences: [], missingEvidence: [] };
      },
    };

    const critic = new Critic({
      criticProvider: fakeCriticProvider,
      config: loadTestConfig((y) => y.replace("enabled: false", "enabled: true")),
      logger: createLogger(),
      requirements: [],
      budget,
    });

    await critic.review(validatedFinding(), fakeValidationOutcome(), "/tmp/does-not-matter");

    // Exactly 1 (the provider's own real request), NOT 2 (provider's + a
    // redundant caller-side record).
    expect(budget.criticCalls).toBe(1);
  });
});
