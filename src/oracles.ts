import type { Observation, OracleResult, RecordedStep } from "./types.js";

export interface Oracle {
  id: string;
  evaluate(
    before: Observation,
    action: RecordedStep,
    after: Observation
  ): Promise<OracleResult>;
}

/**
 * Detects newly introduced error-level console messages after an action.
 * Uses a multiset diff (not a simple length compare) so a pre-existing
 * error that persists across the action is never miscounted as new.
 */
export class ConsoleErrorOracle implements Oracle {
  id = "console-error";

  // eslint-disable-next-line @typescript-eslint/require-await
  async evaluate(
    before: Observation,
    _action: RecordedStep,
    after: Observation
  ): Promise<OracleResult> {
    const beforeErrorTexts = before.consoleMessages
      .filter((message) => message.type === "error")
      .map((message) => message.text);

    const afterErrors = after.consoleMessages.filter((message) => message.type === "error");

    const remaining = [...afterErrors];
    for (const text of beforeErrorTexts) {
      const index = remaining.findIndex((message) => message.text === text);
      if (index !== -1) {
        remaining.splice(index, 1);
      }
    }

    const suspicious = remaining.length > 0;

    return {
      oracleId: this.id,
      suspicious,
      expected: "0 new unexpected error-level console messages",
      actual: `${remaining.length} new unexpected error-level console message${
        remaining.length === 1 ? "" : "s"
      }`,
      ...(suspicious
        ? { details: { newErrors: remaining.map((message) => message.text) } }
        : {}),
    };
  }
}

export function defaultOracles(): Oracle[] {
  return [new ConsoleErrorOracle()];
}
