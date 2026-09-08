import type { AppConfig } from "./config.js";
import type { Observation, OracleResult, RecordedStep } from "./types.js";

export interface Oracle {
  id: string;
  evaluate(before: Observation, action: RecordedStep, after: Observation): Promise<OracleResult>;
}

// Imported after the interface declaration to keep this file readable
// top-down; the circular type-only reference each oracle module has back
// to `Oracle` here is erased at compile time, so there is no runtime cycle.
import { createConsoleErrorOracle } from "./oracles/console-error.js";
import { createDuplicateRequestOracle } from "./oracles/duplicate-request.js";
import { createHttpFailureOracle } from "./oracles/http-failure.js";
import { createPageErrorOracle } from "./oracles/page-error.js";
import { createUiApiConsistencyOracle } from "./oracles/ui-api-consistency.js";

/**
 * One reviewed comparison strategy (multiset diff) reused by all four
 * oracles instead of a second untested strategy for no functional gain.
 * Each oracle's `evaluate` is a pure function of (before, action, after) —
 * the same method Validator calls both for live detection and clean-session
 * replay, so "replay evaluator support" needs no separate interface method.
 *
 * Order matters: the orchestrator's EVALUATE state checks oracles in this
 * order and stops at the first suspicious one for a given action (one
 * finding per action, matching Phase-0's original "first suspicious wins"
 * semantics, just scoped per-action instead of per-run). duplicate-request
 * is deliberately checked before console-error: a double-click heuristic
 * can trigger both a duplicate request AND a console error in the exact
 * same action (e.g. a form whose submit handler both logs an error and
 * fires a request every time) — checking the more specific,
 * action-pattern-scoped oracle first prevents the general console-error
 * oracle from permanently masking it.
 *
 * ui-api-consistency is checked before every other oracle for the same
 * reason, one level up: every ui-api-consistency violation is also an
 * http-failure (same underlying >=500 status), so http-failure would
 * always win first and this oracle could never fire otherwise.
 */
export function buildOracleRegistry(config: AppConfig): Oracle[] {
  const registry: Oracle[] = [];
  if (config.oracles.uiApiConsistency.enabled) registry.push(createUiApiConsistencyOracle(config));
  if (config.oracles.duplicateRequest.enabled) registry.push(createDuplicateRequestOracle(config));
  if (config.oracles.httpFailure.enabled) registry.push(createHttpFailureOracle());
  if (config.oracles.pageError.enabled) registry.push(createPageErrorOracle());
  if (config.oracles.console.enabled) registry.push(createConsoleErrorOracle(config));
  return registry;
}
