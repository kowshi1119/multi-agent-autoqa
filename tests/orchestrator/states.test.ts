import { describe, expect, it } from "vitest";
import {
  assertValidTransition,
  InvalidTransitionError,
  VALID_TRANSITIONS,
  type QaState,
} from "../../src/orchestrator/states.js";

const ALL_STATES = Object.keys(VALID_TRANSITIONS) as QaState[];

describe("FSM transitions", () => {
  it("accepts every transition listed in VALID_TRANSITIONS", () => {
    for (const from of ALL_STATES) {
      for (const to of VALID_TRANSITIONS[from]) {
        expect(() => assertValidTransition(from, to)).not.toThrow();
      }
    }
  });

  it("rejects a representative sample of invalid transitions", () => {
    const invalidPairs: [QaState, QaState][] = [
      ["MAP", "EXECUTE"],
      ["COMPLETE", "MAP"],
      ["INITIALIZE", "COMPLETE"],
      ["EXPLORE", "OBSERVE"],
      ["OBSERVE", "MAP"],
      ["VALIDATE", "EVALUATE"],
      ["CONTINUE", "EXECUTE"],
      ["FAILED", "MAP"],
    ];
    for (const [from, to] of invalidPairs) {
      expect(() => assertValidTransition(from, to)).toThrow(InvalidTransitionError);
    }
  });

  it("has no outgoing transitions from terminal states", () => {
    expect(VALID_TRANSITIONS.COMPLETE).toEqual([]);
    expect(VALID_TRANSITIONS.FAILED).toEqual([]);
  });

  it("makes FAILED reachable from every non-terminal state", () => {
    for (const state of ALL_STATES) {
      if (state === "COMPLETE" || state === "FAILED") continue;
      expect(VALID_TRANSITIONS[state]).toContain("FAILED");
    }
  });
});
