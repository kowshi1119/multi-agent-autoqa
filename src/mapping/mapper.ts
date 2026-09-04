import type { Observation } from "../types.js";
import type { ApplicationMap, PageEdge, PageNode } from "./types.js";

/**
 * Page-mapping identity (keyed by normalized pathname) is deliberately
 * coarser than a state signature (pathname + controls + visible text, used
 * only for heuristic-tracking/dedup — see state-signature.ts). A half-filled
 * form is a different *state* of the *same page*. Conflating the two would
 * either explode the map with a "new page" on every DOM change, or
 * under-count untested heuristics if pathname alone drove tracking. Keep
 * them as two separate keys throughout the codebase.
 */
export class PageMapper {
  private readonly byPathname = new Map<string, PageNode>();
  private readonly edges: PageEdge[] = [];
  private nextId = 1;

  upsertPage(observation: Observation, now: string): PageNode {
    const existing = this.byPathname.get(observation.page.pathname);
    if (existing) {
      existing.controls = mergeByKey(existing.controls, observation.interactiveElements, (el) => `${el.role ?? ""}:${el.name ?? el.label ?? ""}`);
      existing.links = mergeByKey(existing.links, observation.links, (l) => l.href);
      return existing;
    }

    const node: PageNode = {
      id: `PAGE-${String(this.nextId).padStart(3, "0")}`,
      url: observation.page.url,
      pathname: observation.page.pathname,
      title: observation.page.title,
      firstSeenAt: now,
      controls: [...observation.interactiveElements],
      links: [...observation.links],
      testedHeuristics: [],
    };
    this.nextId += 1;
    this.byPathname.set(observation.page.pathname, node);
    return node;
  }

  getByPathname(pathname: string): PageNode | undefined {
    return this.byPathname.get(pathname);
  }

  recordEdge(fromPageId: string, toPageId: string, action: { type: string; label?: string }): void {
    const alreadyExists = this.edges.some(
      (edge) =>
        edge.fromPageId === fromPageId &&
        edge.toPageId === toPageId &&
        edge.action.type === action.type &&
        edge.action.label === action.label
    );
    if (!alreadyExists) {
      this.edges.push({ fromPageId, toPageId, action });
    }
  }

  toJSON(): ApplicationMap {
    return { pages: [...this.byPathname.values()], edges: [...this.edges] };
  }
}

function mergeByKey<T>(existing: T[], incoming: T[], keyOf: (item: T) => string): T[] {
  const byKey = new Map(existing.map((item) => [keyOf(item), item]));
  for (const item of incoming) {
    byKey.set(keyOf(item), item);
  }
  return [...byKey.values()];
}
