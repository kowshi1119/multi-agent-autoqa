export type QaState =
  | "INITIALIZE"
  | "MAP"
  | "PLAN"
  | "EXPLORE"
  | "EXECUTE"
  | "OBSERVE"
  | "EVALUATE"
  | "VALIDATE"
  | "RECORD_FINDING"
  | "CONTINUE"
  | "COMPLETE"
  | "FAILED";

/**
 * The top-level workflow is a deterministic FSM — LLMs operate only inside
 * selected states (PLAN/EXPLORE), they never choose a state transition
 * directly. FAILED is reachable from every non-terminal state (the
 * orchestrator's run loop forces it on any thrown error, bypassing the
 * normal per-state transition it was in the middle of) so it isn't itself
 * a "decision" a state handler makes.
 */
export const VALID_TRANSITIONS: Record<QaState, QaState[]> = {
  INITIALIZE: ["MAP", "FAILED"],
  MAP: ["PLAN", "FAILED"],
  PLAN: ["EXPLORE", "CONTINUE", "FAILED"],
  EXPLORE: ["EXECUTE", "CONTINUE", "FAILED"],
  EXECUTE: ["OBSERVE", "CONTINUE", "FAILED"],
  OBSERVE: ["EVALUATE", "FAILED"],
  EVALUATE: ["CONTINUE", "VALIDATE", "FAILED"],
  VALIDATE: ["RECORD_FINDING", "FAILED"],
  RECORD_FINDING: ["CONTINUE", "FAILED"],
  CONTINUE: ["MAP", "COMPLETE", "FAILED"],
  COMPLETE: [],
  FAILED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: QaState,
    public readonly to: QaState
  ) {
    super(`Invalid FSM transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertValidTransition(from: QaState, to: QaState): void {
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}
