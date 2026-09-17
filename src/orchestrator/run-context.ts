import type { Finding, RecordedStep } from "../types.js";
import type { QaState } from "./states.js";

/**
 * Typed, single-owner run state threaded through every FSM step — no
 * untyped globals. `frontier` holds discovered same-origin URLs not yet
 * visited (drives multi-page traversal); `offeredHeuristicKeys` is the set
 * of distinct (pageState, control, heuristic) tracking keys ever offered
 * by the Planner, for heuristic-coverage reporting (heuristicsExecuted /
 * offeredHeuristicKeys.size). Deliberately a Set, not an incrementing
 * counter: an unexecuted candidate is re-offered on every subsequent
 * planning cycle until it's chosen, so counting each *offer* instead of
 * each *distinct combo* would over-count by roughly a triangular-number
 * factor (confirmed empirically: 22 executed heuristics reported as only
 * 9% "coverage" against a wildly inflated denominator).
 */
export type RunContext = {
  runId: string;
  state: QaState;
  currentUrl: string;
  currentPageId?: string;
  actionsPerformed: number;
  modelCalls: number;
  pagesVisited: number;
  heuristicsExecuted: number;
  findings: Finding[];
  rawAnomalies?: number;
  recordedSteps: RecordedStep[];
  testedHeuristics: Set<string>;
  visitedPages: Set<string>;
  startedAt: string;
  elapsedMs: number;
  stopReason?: string;
  frontier: string[];
  offeredHeuristicKeys: Set<string>;
};

export function createRunContext(runId: string, startedAt: Date, initialUrl: string): RunContext {
  return {
    runId,
    state: "INITIALIZE",
    currentUrl: initialUrl,
    actionsPerformed: 0,
    modelCalls: 0,
    pagesVisited: 0,
    heuristicsExecuted: 0,
    findings: [],
    recordedSteps: [],
    testedHeuristics: new Set<string>(),
    visitedPages: new Set<string>(),
    startedAt: startedAt.toISOString(),
    elapsedMs: 0,
    frontier: [],
    offeredHeuristicKeys: new Set<string>(),
  };
}
