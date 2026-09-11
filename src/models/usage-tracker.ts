export type UsageRole = "explorer" | "critic";
export type UsageOutcome = "success" | "error" | "timeout";

export type UsageAttempt = {
  provider: string;
  role: UsageRole;
  attemptNumber: number;
  requestStartedAt: string;
  requestEndedAt: string;
  latencyMs: number;
  outcome: UsageOutcome;
  /** null when the provider's response didn't report usage (most providers/paths today) -- never fabricated as 0. */
  tokenUsage: { input: number; output: number } | null;
};

export type UsageSummary = {
  explorer: { requests: number; tokenUsage: { input: number; output: number } | null };
  critic: { requests: number; tokenUsage: { input: number; output: number } | null };
};

/**
 * Records every actual provider request attempt (Phase 4 Milestone D1) --
 * a real, measured count, distinct from BudgetTracker's own
 * modelCalls/criticCalls counters (which gate WHETHER a call is allowed;
 * this records what actually happened to each one that was made,
 * including latency and outcome). One instance per run, shared by the
 * Explorer and every per-finding Critic instance the Orchestrator
 * constructs, and by src/experiments/conditions.ts's offline replay path
 * so both share the same accounting shape (though conditions.ts's own
 * instance is typically discarded rather than surfaced in a live run's
 * report -- offline replay is a separate accounting scope by design).
 */
export class UsageTracker {
  private readonly attempts: UsageAttempt[] = [];

  /** Wraps a single provider call attempt, recording latency/outcome/tokenUsage regardless of success or failure -- never swallows the error, only observes it. */
  async recordAttempt<T>(
    provider: string,
    role: UsageRole,
    attemptNumber: number,
    call: () => Promise<T>,
    extractTokenUsage: (result: T) => { input: number; output: number } | null = () => null
  ): Promise<T> {
    const startedAt = new Date();
    try {
      const result = await call();
      this.attempts.push({
        provider,
        role,
        attemptNumber,
        requestStartedAt: startedAt.toISOString(),
        requestEndedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt.getTime(),
        outcome: "success",
        tokenUsage: extractTokenUsage(result),
      });
      return result;
    } catch (error) {
      const isTimeout = error instanceof Error && /timeout|exceeded providerTimeoutMs/i.test(error.message);
      this.attempts.push({
        provider,
        role,
        attemptNumber,
        requestStartedAt: startedAt.toISOString(),
        requestEndedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt.getTime(),
        outcome: isTimeout ? "timeout" : "error",
        tokenUsage: null,
      });
      throw error;
    }
  }

  getAttempts(): UsageAttempt[] {
    return [...this.attempts];
  }

  summary(): UsageSummary {
    const byRole = (role: UsageRole): { requests: number; tokenUsage: { input: number; output: number } | null } => {
      const entries = this.attempts.filter((a) => a.role === role);
      const withUsage = entries.filter((a) => a.tokenUsage !== null);
      const tokenUsage =
        withUsage.length === entries.length && entries.length > 0
          ? withUsage.reduce((sum, a) => ({ input: sum.input + (a.tokenUsage?.input ?? 0), output: sum.output + (a.tokenUsage?.output ?? 0) }), { input: 0, output: 0 })
          : null; // Any attempt with unknown usage makes the total unknown too -- never partially summed and presented as complete.
      return { requests: entries.length, tokenUsage };
    };
    return { explorer: byRole("explorer"), critic: byRole("critic") };
  }
}
