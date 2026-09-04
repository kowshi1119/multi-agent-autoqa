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

/**
 * One reviewed comparison strategy (multiset diff) reused by all four
 * oracles instead of a second untested strategy for no functional gain.
 * Each oracle's `evaluate` is a pure function of (before, action, after) —
 * the same method Validator calls both for live detection and clean-session
 * replay, so "replay evaluator support" needs no separate interface method.
 */
export function buildOracleRegistry(config: AppConfig): Oracle[] {
  const registry: Oracle[] = [];
  if (config.oracles.console.enabled) registry.push(createConsoleErrorOracle(config));
  if (config.oracles.pageError.enabled) registry.push(createPageErrorOracle());
  if (config.oracles.httpFailure.enabled) registry.push(createHttpFailureOracle());
  if (config.oracles.duplicateRequest.enabled) registry.push(createDuplicateRequestOracle(config));
  return registry;
}
