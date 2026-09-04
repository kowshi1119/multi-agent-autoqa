import type { QaHeuristic } from "../heuristics.js";
import { buildFillAndMaybeSubmit, isUsableWidget } from "./support.js";

export function createH06NumericZero(): QaHeuristic {
  return {
    id: "H06",
    name: "Numeric zero",
    appliesTo: ["number_field"],
    risk: "safe",
    isApplicable(_observation, element) {
      return isUsableWidget(element, ["number_field"]);
    },
    async buildTest(observation, element) {
      if (!element) return [];
      return buildFillAndMaybeSubmit(observation, element, "0");
    },
  };
}
