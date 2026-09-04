import type { AppConfig } from "../../config.js";
import type { QaHeuristic } from "../heuristics.js";
import { isUsableWidget, toElementTarget } from "./support.js";

/**
 * Two sequential clicks (not Playwright's native dblclick()) — more
 * reliably produces two independent submit attempts than a single
 * double-click gesture, which is what actually exercises a duplicate-POST
 * defect. Never targets a real payment endpoint: gated to safeMode AND the
 * configured local fixture, on top of the normal widget-type check.
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
    async buildTest(_observation, element) {
      if (!element) return [];
      const target = toElementTarget(element);
      return [
        { type: "click", target },
        { type: "click", target },
      ];
    },
  };
}
