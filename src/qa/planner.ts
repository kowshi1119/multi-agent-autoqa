import type { AppConfig } from "../config.js";
import { isOriginAllowed } from "../actions.js";
import { buildHeuristicTrackingKey, hasExecuted } from "./heuristic-tracker.js";
import type { QaHeuristic } from "./heuristics.js";
import { heuristicRiskToActionRisk } from "./heuristics.js";
import { controlKey, normalizePathname } from "../mapping/state-signature.js";
import type { RunContext } from "../orchestrator/run-context.js";
import type { InteractiveElement, Observation, TestCandidate } from "../types.js";

const STOP_CANDIDATE: TestCandidate = {
  id: "stop",
  kind: "control",
  description: "Stop exploring",
  risk: "safe",
  actions: [{ type: "stop", reason: "" }],
};

/** Priority tiers per §15: normal workflow < required/empty validation < boundary values < state/navigation < network-sensitive. Lower sorts first. */
const HEURISTIC_PRIORITY: Record<string, number> = {
  H01: 2,
  H02: 2,
  H03: 3,
  H04: 3,
  H05: 3,
  H06: 3,
  H07: 3,
  H08: 3,
  H09: 4,
  H10: 5,
};
const NAVIGATION_PRIORITY = 1;
const STOP_PRIORITY = 6;

function priorityOf(candidate: TestCandidate): number {
  if (candidate.kind === "navigation") return NAVIGATION_PRIORITY;
  if (candidate.id === "stop") return STOP_PRIORITY;
  return (candidate.heuristicId ? HEURISTIC_PRIORITY[candidate.heuristicId] : undefined) ?? STOP_PRIORITY - 1;
}

function isUsable(element: InteractiveElement): boolean {
  return element.visible && element.enabled !== false;
}

/**
 * Deterministic candidate generation: Observation -> controls -> applicable
 * untested heuristics -> prioritized list handed to the Explorer. The
 * Explorer picks a candidate id; it never invents a heuristic or action.
 */
export class Planner {
  constructor(
    private readonly heuristics: QaHeuristic[],
    private readonly config: AppConfig
  ) {}

  async plan(observation: Observation, ctx: RunContext): Promise<TestCandidate[]> {
    const candidates: TestCandidate[] = [];

    for (const element of observation.interactiveElements) {
      if (!isUsable(element)) continue;
      const key = controlKey(element);

      for (const heuristic of this.heuristics) {
        if (!heuristic.isApplicable(observation, element)) continue;

        const trackingKey = buildHeuristicTrackingKey(observation.stateSignature, key, heuristic.id);
        ctx.heuristicsApplicableCount += 1;
        if (hasExecuted(ctx, trackingKey)) continue;

        const actions = await heuristic.buildTest(observation, element);
        if (actions.length === 0) continue;

        candidates.push({
          id: `${heuristic.id}|${key}`,
          kind: "heuristic",
          heuristicId: heuristic.id,
          controlKey: key,
          description: `${heuristic.name} on ${key}`,
          risk: heuristicRiskToActionRisk(heuristic.risk),
          actions,
          trackingKey,
        });
      }
    }

    for (const link of observation.links) {
      if (!link.sameOrigin || !isOriginAllowed(link.href, this.config.safety.allowedOrigins)) continue;
      if (ctx.visitedPages.has(normalizePathname(link.href))) continue;
      candidates.push({
        id: `nav|${link.href}`,
        kind: "navigation",
        description: `Navigate to ${link.text ?? link.href}`,
        risk: "safe",
        actions: [{ type: "navigate", url: link.href }],
      });
    }

    // Frontier fallback: pages discovered earlier (e.g. via a link on a
    // different page) but not reachable from *this* page's own links --
    // without this, coverage would depend on the whole app being
    // link-connected from wherever exploration happens to be standing.
    for (const url of ctx.frontier) {
      if (ctx.visitedPages.has(normalizePathname(url))) continue;
      if (candidates.some((c) => c.kind === "navigation" && c.actions[0]?.type === "navigate" && c.actions[0].url === url)) {
        continue;
      }
      if (!isOriginAllowed(url, this.config.safety.allowedOrigins)) continue;
      candidates.push({
        id: `nav|${url}`,
        kind: "navigation",
        description: `Navigate to ${url} (discovered earlier)`,
        risk: "safe",
        actions: [{ type: "navigate", url }],
      });
    }

    candidates.push(STOP_CANDIDATE);
    return candidates.sort((a, b) => priorityOf(a) - priorityOf(b));
  }
}
