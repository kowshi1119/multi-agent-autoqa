import type { Oracle } from "../oracles.js";
import type { Observation, OracleResult } from "../types.js";
import { newItemsByKey } from "./multiset-diff.js";

/** Detects newly introduced uncaught runtime errors (Playwright 'pageerror'), kept separate from console-error. */
export function createPageErrorOracle(): Oracle {
  return {
    id: "page-error",
    // eslint-disable-next-line @typescript-eslint/require-await
    async evaluate(before: Observation, _action, after: Observation): Promise<OracleResult> {
      const remaining = newItemsByKey(before.pageErrors, after.pageErrors, (e) => e.message);
      const suspicious = remaining.length > 0;

      return {
        oracleId: "page-error",
        suspicious,
        expected: "0 new uncaught runtime errors",
        actual: `${remaining.length} new uncaught runtime error${remaining.length === 1 ? "" : "s"}`,
        ...(suspicious ? { details: { newErrors: remaining.map((e) => e.message) } } : {}),
      };
    },
  };
}
