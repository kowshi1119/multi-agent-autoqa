import type { QaHeuristic } from "../heuristics.js";
import { buildFillAndMaybeSubmit, FILLABLE_TEXT_TYPES, isUsableWidget } from "./support.js";

export function createH04Unicode(): QaHeuristic {
  return {
    id: "H04",
    name: "Unicode input",
    appliesTo: FILLABLE_TEXT_TYPES,
    risk: "safe",
    isApplicable(_observation, element) {
      return isUsableWidget(element, FILLABLE_TEXT_TYPES);
    },
    async buildTest(observation, element) {
      if (!element) return [];
      return buildFillAndMaybeSubmit(observation, element, "AutoQA தமிழ் ñ 漢字");
    },
  };
}
