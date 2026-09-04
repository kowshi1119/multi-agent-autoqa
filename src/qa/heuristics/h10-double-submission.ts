import type { AppConfig } from "../../config.js";
import type { QaAction } from "../../types.js";
import type { QaHeuristic } from "../heuristics.js";
import { findFormFor, isUsableWidget, toElementTarget } from "./support.js";

/**
 * Two sequential clicks (not Playwright's native dblclick()) — more
 * reliably produces two independent submit attempts than a single
 * double-click gesture, which is what actually exercises a duplicate-POST
 * defect. Never targets a real payment endpoint: gated to safeMode AND the
 * configured local fixture, on top of the normal widget-type check.
 *
 * Fills any other `required` fields in the enclosing form with a safe
 * value first. Without this, a required field left empty by an earlier
 * heuristic (or a prior reload) causes the browser's own native form
 * validation to silently block *both* submit attempts — no console error,
 * no request, nothing for any oracle to see — which isn't a "no defect
 * found" result, it's the heuristic never actually exercising the
 * double-submit scenario at all (confirmed by hitting exactly this case
 * against the /form fixture page).
 */
export function createH10DoubleSubmission(config: AppConfig): QaHeuristic {
  return {
    id: "H10",
    name: "Double submission",
    appliesTo: ["submit_button"],
    risk: "moderate",
    isApplicable(_observation, element) {
      if (!config.safety.safeMode || config.target.environment !== "local-fixture") return false;
      return isUsableWidget(element, ["submit_button"]);
    },
    async buildTest(observation, element) {
      if (!element) return [];

      const actions: QaAction[] = [];
      const form = findFormFor(observation, element);
      if (form) {
        for (const field of form.fields) {
          if (!field.required || field === form.submitControl) continue;
          const value = field.widgetType === "number_field" ? "1" : "AutoQA double-submit check";
          actions.push({ type: "fill", target: toElementTarget(field), value });
        }
      }

      const target = toElementTarget(element);
      actions.push({ type: "click", target }, { type: "click", target });
      return actions;
    },
  };
}
