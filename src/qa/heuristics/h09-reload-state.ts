import type { QaHeuristic } from "../heuristics.js";
import { buildFillAndMaybeSubmit, FILLABLE_TEXT_TYPES, isUsableWidget } from "./support.js";

const APPLIES_TO = [...FILLABLE_TEXT_TYPES, "number_field"] as const;

/**
 * Enters a safe value, submits if possible, then reloads. Phase 1 has no
 * generic "did this specific field persist this specific value" oracle —
 * that would require app-specific ground truth AutoQA can't infer. This
 * heuristic relies entirely on the shared oracle registry catching any
 * *incidental* anomaly (a new console/page/network error) the reload
 * triggers, not a bespoke persistence check. Documented as a scoping
 * decision, not a bug, in the README's Known Limitations.
 */
export function createH09ReloadState(): QaHeuristic {
  return {
    id: "H09",
    name: "Reload / state preservation",
    appliesTo: [...APPLIES_TO],
    risk: "safe",
    isApplicable(_observation, element) {
      return isUsableWidget(element, [...APPLIES_TO]);
    },
    async buildTest(observation, element) {
      if (!element) return [];
      const value = element.widgetType === "number_field" ? "42" : "AutoQA reload check";
      return [...buildFillAndMaybeSubmit(observation, element, value), { type: "reload" }];
    },
  };
}
