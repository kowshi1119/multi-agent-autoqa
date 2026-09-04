import type { AppConfig } from "../config.js";
import type { Oracle } from "../oracles.js";
import type { Observation, OracleResult } from "../types.js";
import { newItemsByKey } from "./multiset-diff.js";

/**
 * Detects newly introduced error-level console messages. Configured
 * ignorePatterns are filtered out of both before/after before diffing, so
 * a known-noisy error (e.g. a third-party script) never counts as new
 * *or* keeps getting silently absorbed into "persisting" — it simply never
 * participates in the comparison at all.
 */
export function createConsoleErrorOracle(config: AppConfig): Oracle {
  const ignoreRegexes = config.oracles.console.ignorePatterns.map((pattern) => new RegExp(pattern));

  function isIgnored(text: string): boolean {
    return ignoreRegexes.some((regex) => regex.test(text));
  }

  return {
    id: "console-error",
    // eslint-disable-next-line @typescript-eslint/require-await
    async evaluate(before: Observation, _action, after: Observation): Promise<OracleResult> {
      const beforeErrors = before.consoleMessages.filter((m) => m.type === "error" && !isIgnored(m.text));
      const afterErrors = after.consoleMessages.filter((m) => m.type === "error" && !isIgnored(m.text));

      const remaining = newItemsByKey(beforeErrors, afterErrors, (m) => m.text);
      const suspicious = remaining.length > 0;

      return {
        oracleId: "console-error",
        suspicious,
        expected: "0 new unexpected error-level console messages",
        actual: `${remaining.length} new unexpected error-level console message${remaining.length === 1 ? "" : "s"}`,
        ...(suspicious ? { details: { newErrors: remaining.map((m) => m.text) } } : {}),
      };
    },
  };
}
