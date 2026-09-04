import type { Finding, RecordedStep } from "../types.js";
import type { QaState } from "./states.js";

/**
 * Typed, single-owner run state threaded through every FSM step — no
 * untyped globals. `frontier` holds discovered same-origin URLs not yet
 * visited (drives multi-page traversal); `heuristicsApplicableCount`
 * accumulates every distinct (pageState, control, heuristic) combo ever
 * offered by the Planner, for heuristic-coverage reporting.
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
  recordedSteps: RecordedStep[];
  testedHeuristics: Set<string>;
  visitedPages: Set<string>;
  startedAt: string;
  elapsedMs: number;
  stopReason?: string;
  frontier: string[];
  heuristicsApplicableCount: number;
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
    heuristicsApplicableCount: 0,
  };
}
