import type { RunContext } from "../orchestrator/run-context.js";

/** Pinned §14 format: pageState|role:name|heuristicId. `controlKey` must come from mapping/state-signature.ts. */
export function buildHeuristicTrackingKey(pageState: string, controlKey: string, heuristicId: string): string {
  return `${pageState}|${controlKey}|${heuristicId}`;
}

export function hasExecuted(ctx: RunContext, key: string): boolean {
  return ctx.testedHeuristics.has(key);
}

export function markExecuted(ctx: RunContext, key: string): void {
  ctx.testedHeuristics.add(key);
}
