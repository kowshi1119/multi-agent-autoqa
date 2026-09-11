import { describe, expect, it } from "vitest";
import { UsageTracker } from "../../src/models/usage-tracker.js";

describe("UsageTracker (Phase 4 Milestone D1)", () => {
  it("records a successful attempt with measured latency and token usage when the provider reports it", async () => {
    const tracker = new UsageTracker();
    const result = await tracker.recordAttempt(
      "anthropic",
      "explorer",
      1,
      () => Promise.resolve({ text: "ok", usage: { input_tokens: 100, output_tokens: 20 } }),
      (r) => ({ input: r.usage.input_tokens, output: r.usage.output_tokens })
    );

    expect(result.text).toBe("ok");
    const attempts = tracker.getAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("success");
    expect(attempts[0]?.tokenUsage).toEqual({ input: 100, output: 20 });
    expect(attempts[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records tokenUsage as null (never fabricated as 0) when the provider doesn't report it", async () => {
    const tracker = new UsageTracker();
    await tracker.recordAttempt("mock", "explorer", 1, () => Promise.resolve("done"));
    expect(tracker.getAttempts()[0]?.tokenUsage).toBeNull();
  });

  it("counts every actual call attempt, including simulated repair/retry calls, as its own entry", async () => {
    const tracker = new UsageTracker();
    // Simulates a real provider path (e.g. AnthropicModelProvider) that
    // issues a first call, gets invalid output, and issues one repair
    // call -- both are real network attempts and must both be counted.
    await tracker.recordAttempt("anthropic", "explorer", 1, () => Promise.resolve("invalid output"));
    await tracker.recordAttempt("anthropic", "explorer", 2, () => Promise.resolve("repaired output"));

    const attempts = tracker.getAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
    expect(tracker.summary().explorer.requests).toBe(2);
  });

  it("records outcome:'error' for a rejected call, still observing it rather than swallowing it", async () => {
    const tracker = new UsageTracker();
    await expect(tracker.recordAttempt("mock", "critic", 1, () => Promise.reject(new Error("provider outage")))).rejects.toThrow(
      "provider outage"
    );
    const attempts = tracker.getAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("error");
  });

  it("records outcome:'timeout' (not a hang) when the wrapped call rejects with a timeout-shaped error", async () => {
    const tracker = new UsageTracker();
    await expect(
      tracker.recordAttempt("anthropic", "critic", 1, () => Promise.reject(new Error("Critic call exceeded providerTimeoutMs (150ms)")))
    ).rejects.toThrow();
    expect(tracker.getAttempts()[0]?.outcome).toBe("timeout");
  });

  it("summary() sums tokenUsage across a role's attempts only when ALL of them reported it -- otherwise the total is unknown, never partially summed", async () => {
    const tracker = new UsageTracker();
    await tracker.recordAttempt(
      "anthropic",
      "explorer",
      1,
      () => Promise.resolve({}),
      () => ({ input: 50, output: 10 })
    );
    await tracker.recordAttempt("anthropic", "explorer", 2, () => Promise.resolve({})); // no usage reported this time

    const summary = tracker.summary();
    expect(summary.explorer.requests).toBe(2);
    expect(summary.explorer.tokenUsage).toBeNull();
  });

  it("summary() distinguishes explorer and critic roles independently", async () => {
    const tracker = new UsageTracker();
    await tracker.recordAttempt("mock", "explorer", 1, () => Promise.resolve("x"));
    await tracker.recordAttempt("mock", "explorer", 2, () => Promise.resolve("x"));
    await tracker.recordAttempt("mock", "critic", 1, () => Promise.resolve("x"));

    const summary = tracker.summary();
    expect(summary.explorer.requests).toBe(2);
    expect(summary.critic.requests).toBe(1);
  });
});
