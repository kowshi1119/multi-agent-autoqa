import type { QaHeuristic } from "../heuristics.js";
import { buildFillAndMaybeSubmit, isUsableWidget } from "./support.js";

export function createH08LargeNumeric(): QaHeuristic {
  return {
    id: "H08",
    name: "Large numeric value",
    appliesTo: ["number_field"],
    risk: "moderate",
    isApplicable(_observation, element) {
      return isUsableWidget(element, ["number_field"]);
    },
    async buildTest(observation, element) {
      if (!element) return [];
      return buildFillAndMaybeSubmit(observation, element, "999999999");
    },
  };
}
