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
};

/**
 * Tracks every Phase-1 budget, including wall clock. The `now` param is
 * the load-bearing testability decision: budget-exhaustion tests inject a
 * fake clock instead of sleeping in real time, so maxDurationMs tests are
 * deterministic and fast rather than flaky.
 */
export class BudgetTracker {
  private actionsUsed = 0;
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
      actionsUsed: this.actionsUsed,
      modelCallsUsed: this.modelCallsUsed,
      pagesUsed: this.pagesUsed,
      findingsUsed: this.findingsUsed,
      durationMs: this.elapsedMs(),
      criticCallsUsed: this.criticCallsUsed,
    };
  }
}
