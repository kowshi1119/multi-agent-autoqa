import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCondition } from "../../src/experiments/conditions.js";
import { createLogger } from "../../src/logger.js";
import { MockCriticProvider } from "../../src/critic/mock-critic-provider.js";
import type { GroundTruthDefect } from "../../src/reporting/benchmark.js";
import type { Finding } from "../../src/types.js";
import { loadTestConfig } from "../helpers/test-config.js";

/**
 * Phase 4 Milestone D1: src/experiments/conditions.ts#runCondition() used
 * to call criticProvider.critique() directly with no timeout and no
 * request cap -- unlike the live per-run path (src/critic/critic-runner.ts
 * #Critic.review()), which enforces both. Sharing buildCriticInput()/
 * decideDisposition() alone did not guarantee this parity; these tests
 * prove the fix, not just that the shared functions are still called.
 */

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "FINDING-001",
    title: "t",
    status: "validated",
    category: "network",
    pageId: "PAGE-001",
    url: "http://localhost:4173/payment",
    pathname: "/payment",
    expected: "e",
    actual: "a",
    oracle: {
      oracleId: "http-failure",
      suspicious: true,
      expected: "e",
      actual: "a",
      details: { newFailures: [{ method: "POST", url: "http://localhost:4173/api/pay-fail", status: 500 }] },
    },
    steps: [],
    reproduction: { attempts: 3, successes: 3 },
    occurrenceCount: 1,
    evidence: ["oracle.json"],
    evidenceLevel: "L3",
    reportDisposition: "needs_human",
    ...overrides,
  };
}

function tempRunDir(findingIds: string[]): string {
  const runDir = mkdtempSync(join(tmpdir(), "autoqa-conditions-budget-test-"));
  for (const id of findingIds) {
    mkdirSync(join(runDir, "findings", id), { recursive: true });
    writeFileSync(join(runDir, "findings", id, "oracle.json"), "{}", "utf-8");
  }
  return runDir;
}

const groundTruth: GroundTruthDefect[] = [{ id: "SEED-003", oracleId: "http-failure", pathname: "/payment" }];

describe("runCondition budget/timeout parity with the live Critic path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects via the timeout wrapper rather than hanging when the critic provider never resolves", async () => {
    const config = loadTestConfig((y) => y.replace("providerTimeoutMs: 30000", "providerTimeoutMs: 150").replace('critic:\n    enabled: false', "critic:\n    enabled: true"));
    const a = finding({ id: "FINDING-001" });
    const runDir = tempRunDir(["FINDING-001"]);

    const hangForever = vi.spyOn(MockCriticProvider.prototype, "critique").mockImplementation(() => new Promise(() => {}));

    const started = Date.now();
    const result = await runCondition("critic_on_grouping_off", [a], runDir, config, [], createLogger(), groundTruth);
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(5_000); // proves it didn't hang for the test's own default timeout
    expect(result.findings[0]?.critic?.verdict).toBe("needs_human");
    expect(result.findings[0]?.critic?.summary).toContain("CRITIC_MODEL_ERROR");
    hangForever.mockRestore();
  }, 10_000);

  it("enforces maxCriticCalls -- a second finding's critic call is skipped as BUDGET_EXHAUSTED, not silently uncapped", async () => {
    const config = loadTestConfig((y) => y.replace("maxCriticCalls: 10", "maxCriticCalls: 1").replace('critic:\n    enabled: false', "critic:\n    enabled: true"));
    const a = finding({ id: "FINDING-001", controlKey: "x" });
    const b = finding({ id: "FINDING-002", controlKey: "y", pathname: "/other" });
    const runDir = tempRunDir(["FINDING-001", "FINDING-002"]);

    const critiqueSpy = vi.spyOn(MockCriticProvider.prototype, "critique");

    const result = await runCondition("critic_on_grouping_off", [a, b], runDir, config, [], createLogger(), groundTruth);

    expect(critiqueSpy).toHaveBeenCalledTimes(1);
    const budgetExhausted = result.findings.filter((f) => f.critic?.summary?.includes("BUDGET_EXHAUSTED"));
    expect(budgetExhausted).toHaveLength(1);
  });
});
