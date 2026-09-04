import type { QaHeuristic } from "../heuristics.js";
import { buildFillAndMaybeSubmit, isUsableWidget } from "./support.js";

/** Never executes a real financial transaction — this only fills the field and observes, on local fixtures only by construction of the overall run target. */
export function createH07NegativeNumeric(): QaHeuristic {
  return {
    id: "H07",
    name: "Negative numeric value",
    appliesTo: ["number_field"],
    risk: "moderate",
    isApplicable(_observation, element) {
      return isUsableWidget(element, ["number_field"]);
    },
    async buildTest(observation, element) {
      if (!element) return [];
      return buildFillAndMaybeSubmit(observation, element, "-1");
    },
  };
}
