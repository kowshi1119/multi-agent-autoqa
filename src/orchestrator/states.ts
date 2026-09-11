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
  | "FAILED"
  | "CANCELLED";

/**
 * The top-level workflow is a deterministic FSM — LLMs operate only inside
 * selected states (PLAN/EXPLORE), they never choose a state transition
 * directly. FAILED and CANCELLED are both reachable from every
 * non-terminal state (the orchestrator's run loop forces one of them on
 * any thrown error / an aborted run, bypassing the normal per-state
 * transition it was in the middle of) so neither is itself a "decision" a
 * state handler makes. CANCELLED (Phase 4 Milestone B) is distinct from
 * FAILED: a user-requested stop is never an error, and a cancelled run's
 * report must say "stopped", never "completed" or "failed".
 */
export const VALID_TRANSITIONS: Record<QaState, QaState[]> = {
  INITIALIZE: ["MAP", "FAILED", "CANCELLED"],
  MAP: ["PLAN", "FAILED", "CANCELLED"],
  PLAN: ["EXPLORE", "CONTINUE", "FAILED", "CANCELLED"],
  EXPLORE: ["EXECUTE", "CONTINUE", "FAILED", "CANCELLED"],
  EXECUTE: ["OBSERVE", "CONTINUE", "FAILED", "CANCELLED"],
  OBSERVE: ["EVALUATE", "FAILED", "CANCELLED"],
  EVALUATE: ["CONTINUE", "VALIDATE", "FAILED", "CANCELLED"],
  VALIDATE: ["RECORD_FINDING", "FAILED", "CANCELLED"],
  RECORD_FINDING: ["CONTINUE", "FAILED", "CANCELLED"],
  CONTINUE: ["MAP", "COMPLETE", "FAILED", "CANCELLED"],
  COMPLETE: [],
  FAILED: [],
  CANCELLED: [],
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
