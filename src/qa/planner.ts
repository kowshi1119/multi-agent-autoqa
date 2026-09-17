import { createHash } from "node:crypto";
import type { ActionPolicy } from "../safety/action-policy.js";
import type { WorkflowManifest } from "../pilot/workflow-manifest.js";
import type { AppConfig } from "../config.js";
import { isOriginAllowed } from "../actions.js";
import { buildHeuristicTrackingKey, hasExecuted } from "./heuristic-tracker.js";
import type { QaHeuristic } from "./heuristics.js";
import { heuristicRiskToActionRisk } from "./heuristics.js";
import { controlKey, normalizePathname } from "../mapping/state-signature.js";
import type { RunContext } from "../orchestrator/run-context.js";
import { redactSecrets } from "../redact.js";
import type { InteractiveElement, Observation, TestCandidate } from "../types.js";

const STOP_CANDIDATE: TestCandidate = {
  id: "stop",
  kind: "control",
  description: "Stop exploring",
  risk: "safe",
  actions: [{ type: "stop", reason: "" }],
};

/**
 * Priority tiers per §15: required/empty validation < boundary values <
 * state/navigation < network-sensitive < move to another page < stop.
 *
 * Navigation deliberately sorts AFTER every heuristic tier, not before:
 * the Planner offers a navigation candidate for every discovered,
 * not-yet-visited page on every cycle, so if navigation ever outranked
 * heuristics the agent would tour the whole site first and never interact
 * with any single page (confirmed empirically — an earlier ordering with
 * navigation first produced exactly that: 5/5 pages "visited," 0
 * heuristics executed, 0 findings). Fully exhausting a page's applicable
 * heuristics before moving on is what "systematic QA tester" actually
 * requires in practice, not just per the spec's literal tier ordering.
 */
const HEURISTIC_PRIORITY: Record<string, number> = {
  H01: 1,
  H02: 1,
  H03: 2,
  H04: 2,
  H05: 2,
  H06: 2,
  H07: 2,
  H08: 2,
  H09: 3,
  H11: 3,
  H10: 4,
};
const NAVIGATION_PRIORITY = 5;
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
  private readonly unsuccessful = new Set<string>();
  private readonly handledWorkflows = new Set<string>();
  markUnsuccessful(state: string, candidate: TestCandidate): void { this.unsuccessful.add(`${state}|${candidate.id}`); }
  markWorkflowHandled(id: string): void { this.handledWorkflows.add(id); }
  constructor(
    private readonly heuristics: QaHeuristic[],
    private readonly config: AppConfig,
    /**
     * This run's transient login credentials (2026-09-15 fix). A
     * "navigate" candidate's `id`/`description` are model-facing (shown in
     * the Explorer prompt, echoed back to identify the chosen candidate)
     * and are built from a page's own href, which can carry a credential --
     * redacted here, at construction, while `candidate.actions[0].url`
     * stays the RAW href, since that's what actually gets navigated to.
     * IDs are opaque hashes of the raw URL so distinct URLs remain distinct
     * even when their displayed descriptions redact identically.
     */
    private readonly extraSecrets: readonly string[] = [],
    private readonly policy?: ActionPolicy,
    private readonly manifest?: WorkflowManifest
  ) {}

  async plan(observation: Observation, ctx: RunContext): Promise<TestCandidate[]> {
    const candidates: TestCandidate[] = [];
    if (this.policy?.isDeclaredMode()) {
      for (const workflow of this.manifest?.workflows ?? []) {
        if (!workflow.execution || this.handledWorkflows.has(workflow.id)) continue;
        // Ordered declarations may include an explicit navigation to their starting page.
        if (workflow.execution.steps[0]?.pathname !== observation.page.pathname) continue;
        if (workflow.execution.steps.some(s => this.policy?.classifyPlannedAction(s.action, s.pathname).decision === "denied")) continue;
        candidates.push({ id: `workflow|${workflow.id}`, workflowId: workflow.id, kind: "control", description: workflow.description, risk: "safe", actions: workflow.execution.steps.map(s => s.action) });
        break;
      }
      return [...candidates, STOP_CANDIDATE];
    }

    for (const element of observation.interactiveElements) {
      if (!isUsable(element)) continue;
      const key = controlKey(element);

      for (const heuristic of this.heuristics) {
        if (!heuristic.isApplicable(observation, element)) continue;

        const trackingKey = buildHeuristicTrackingKey(observation.stateSignature, key, heuristic.id);
        ctx.offeredHeuristicKeys.add(trackingKey);
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
        id: `nav|${createHash("sha256").update(link.href).digest("hex").slice(0, 24)}`,
        kind: "navigation",
        description: `Navigate to ${redactSecrets(link.text ?? link.href, this.extraSecrets)}`,
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
      const redactedUrl = redactSecrets(url, this.extraSecrets);
      candidates.push({
        id: `nav|${createHash("sha256").update(url).digest("hex").slice(0, 24)}`,
        kind: "navigation",
        description: `Navigate to ${redactedUrl} (discovered earlier)`,
        risk: "safe",
        actions: [{ type: "navigate", url }],
      });
    }

    candidates.push(STOP_CANDIDATE);
    return candidates.filter(c => c.id === "stop" || (!this.unsuccessful.has(`${observation.stateSignature}|${c.id}`) && (!this.policy || c.actions.every(a => this.policy!.classifyPlannedAction(a, observation.page.pathname).decision === "allowed")))).sort((a, b) => priorityOf(a) - priorityOf(b));
  }
}
