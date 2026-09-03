export type BudgetStopReason = "max_actions_reached" | "max_model_calls_reached";

/** Tracks the two hard caps that guarantee the agent never runs indefinitely. */
export class Budget {
  private actionsUsed = 0;
  private modelCallsUsed = 0;

  constructor(
    private readonly maxActions: number,
    private readonly maxModelCalls: number
  ) {}

  canCallModel(): boolean {
    return this.modelCallsUsed < this.maxModelCalls;
  }

  canAct(): boolean {
    return this.actionsUsed < this.maxActions;
  }

  recordModelCall(): void {
    this.modelCallsUsed += 1;
  }

  recordAction(): void {
    this.actionsUsed += 1;
  }

  get actionsPerformed(): number {
    return this.actionsUsed;
  }

  get modelCalls(): number {
    return this.modelCallsUsed;
  }
}
