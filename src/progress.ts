import type { Finding } from "./types.js";
import type { QaState } from "./orchestrator/states.js";

/**
 * Ordinary-QA-language status vocabulary for the Phase 4 control panel
 * (Milestone B) -- never a raw FSM state name. "checking-setup" and
 * "signing-in" are emitted by callers outside the Orchestrator's own FSM
 * (preflight runs before a run starts; login happens inside
 * Orchestrator.initialize(), folded into the first "exploring" event's
 * detail string rather than a fully separate FSM phase, a disclosed
 * scoping simplification -- see PROGRESS.md).
 */
export type RunPhase = "checking-setup" | "signing-in" | "exploring" | "reproducing" | "reviewing" | "completed" | "stopped" | "failed";

/**
 * No fake percent-complete against an unknown discovery denominator --
 * these are the actual named counters the spec requires instead.
 */
export type RunProgressEvent = {
  phase: RunPhase;
  detail: string;
  pagesVisited: number;
  actionsPerformed: number;
  remainingActions: number;
  remainingDurationMs: number;
  reportableCount: number;
  needsReviewCount: number;
};

const EXPLORING_STATES = new Set<QaState>(["INITIALIZE", "MAP", "PLAN", "EXPLORE", "EXECUTE", "OBSERVE", "EVALUATE", "CONTINUE", "RECORD_FINDING"]);

export function phaseForState(state: QaState): RunPhase {
  if (state === "VALIDATE") return "reproducing";
  if (state === "COMPLETE") return "completed";
  if (state === "CANCELLED") return "stopped";
  if (state === "FAILED") return "failed";
  if (EXPLORING_STATES.has(state)) return "exploring";
  return "exploring";
}

export function reportableAndNeedsReviewCounts(findings: Finding[]): { reportableCount: number; needsReviewCount: number } {
  let reportableCount = 0;
  let needsReviewCount = 0;
  for (const finding of findings) {
    if (finding.reportDisposition === "report") reportableCount += 1;
    if (finding.reportDisposition === "needs_human") needsReviewCount += 1;
  }
  return { reportableCount, needsReviewCount };
}
