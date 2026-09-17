/**
 * §4 fix (2026-09-14 addendum): thrown from a real provider's own
 * complete() boundary when the budget is already exhausted -- BEFORE that
 * real HTTP request is issued. Previously the budget was checked/recorded
 * once per logical decision (Explorer.decide()/Critic.review()), but a
 * single logical decision can internally make TWO real requests (first
 * attempt + one repair) via the provider's own retry -- a maxModelCalls:1
 * budget could silently permit 2 real requests. Checking at the actual
 * request boundary closes that gap.
 */
export class ModelBudgetExhaustedError extends Error {
  constructor(message = "BUDGET_EXHAUSTED: maxModelCalls reached or duration exceeded") {
    super(message);
    this.name = "ModelBudgetExhaustedError";
  }
}

/** Critic-side counterpart to ModelBudgetExhaustedError -- see its doc comment. */
export class CriticBudgetExhaustedError extends Error {
  constructor(message = "BUDGET_EXHAUSTED: maxCriticCalls reached or duration exceeded") {
    super(message);
    this.name = "CriticBudgetExhaustedError";
  }
}

export type BudgetLimits = {
  maxActions: number;
  maxModelCalls: number;
  maxPages: number;
  maxFindings: number;
  maxDurationMs: number;
  maxCriticCalls: number;
};

export type BudgetSnapshot = BudgetLimits & {
  actionsUsed: number;
  modelCallsUsed: number;
  pagesUsed: number;
  findingsUsed: number;
  durationMs: number;
  criticCallsUsed: number;
  actionOutcomes?: { attempted: number; successful: number; blocked: number; failed: number };
  actionsByPhase?: Record<string, number>;
  browserRequestsByPhase?: Record<string, number>;
};

/**
 * Tracks every Phase-1 budget, including wall clock. The `now` param is
 * the load-bearing testability decision: budget-exhaustion tests inject a
 * fake clock instead of sleeping in real time, so maxDurationMs tests are
 * deterministic and fast rather than flaky.
 */
export class BudgetTracker {
  private actionsUsed = 0;
  private readonly outcomes = { attempted: 0, successful: 0, blocked: 0, failed: 0 };
  private readonly phases: Record<string, number> = {};
  private readonly requests: Record<string, number> = {};
  recordBrowserRequest(authenticating: boolean): void {
    const phase = authenticating ? "authentication" : "afterAuthentication";
    this.requests[phase] = (this.requests[phase] ?? 0) + 1;
  }
  recordAttempt(phase: "authentication" | "execution" | "validation" | "setup"): void {
    if (!this.canAct()) throw new Error("BUDGET_EXHAUSTED: maxActions or maxDurationMs");
    this.recordAction(); this.outcomes.attempted++; this.phases[phase] = (this.phases[phase] ?? 0) + 1;
  }
  recordOutcome(outcome: string): void {
    if (outcome === "success") this.outcomes.successful++;
    else if (outcome === "blocked") this.outcomes.blocked++;
    else this.outcomes.failed++;
  }
  private modelCallsUsed = 0;
  private pagesUsed = 0;
  private findingsUsed = 0;
  private criticCallsUsed = 0;
  private readonly startedAtMs: number;

  constructor(
    private readonly limits: BudgetLimits,
    private readonly now: () => number = Date.now
  ) {
    this.startedAtMs = now();
  }

  elapsedMs(): number {
    return this.now() - this.startedAtMs;
  }

  remainingDurationMs(): number {
    return Math.max(0, this.limits.maxDurationMs - this.elapsedMs());
  }

  isDurationExceeded(): boolean {
    return this.remainingDurationMs() <= 0;
  }

  canCallModel(): boolean {
    return this.modelCallsUsed < this.limits.maxModelCalls && !this.isDurationExceeded();
  }

  canAct(): boolean {
    return this.actionsUsed < this.limits.maxActions && !this.isDurationExceeded();
  }

  canVisitNewPage(): boolean {
    return this.pagesUsed < this.limits.maxPages && !this.isDurationExceeded();
  }

  canRecordFinding(): boolean {
    return this.findingsUsed < this.limits.maxFindings;
  }

  canCallCritic(): boolean {
    return this.criticCallsUsed < this.limits.maxCriticCalls && !this.isDurationExceeded();
  }

  recordAction(): void {
    this.actionsUsed += 1;
  }

  recordModelCall(): void {
    this.modelCallsUsed += 1;
  }

  recordPageVisit(): void {
    this.pagesUsed += 1;
  }

  recordFinding(): void {
    this.findingsUsed += 1;
  }

  recordCriticCall(): void {
    this.criticCallsUsed += 1;
  }

  get actionsPerformed(): number {
    return this.actionsUsed;
  }

  get modelCalls(): number {
    return this.modelCallsUsed;
  }

  get pagesVisited(): number {
    return this.pagesUsed;
  }

  get findingsRecorded(): number {
    return this.findingsUsed;
  }

  get criticCalls(): number {
    return this.criticCallsUsed;
  }

  snapshot(): BudgetSnapshot {
    return {
      ...this.limits,
      ...(Object.keys(this.requests).length ? { browserRequestsByPhase: { ...this.requests } } : {}),
      ...(this.outcomes.attempted ? { actionOutcomes: { ...this.outcomes }, actionsByPhase: { ...this.phases } } : {}),
      actionsUsed: this.actionsUsed,
      modelCallsUsed: this.modelCallsUsed,
      pagesUsed: this.pagesUsed,
      findingsUsed: this.findingsUsed,
      durationMs: this.elapsedMs(),
      criticCallsUsed: this.criticCallsUsed,
    };
  }
}
