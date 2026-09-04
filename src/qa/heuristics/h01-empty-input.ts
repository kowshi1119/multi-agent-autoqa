import type { QaHeuristic } from "../heuristics.js";
import { buildFillAndMaybeSubmit, FILLABLE_TEXT_TYPES, isUsableWidget } from "./support.js";

/** Submits a blank value into a text-like field. Excludes password fields (risk of lockout/account-impacting behavior). */
export function createH01EmptyInput(): QaHeuristic {
  return {
    id: "H01",
    name: "Empty input",
    appliesTo: FILLABLE_TEXT_TYPES,
    risk: "safe",
    isApplicable(_observation, element) {
      return isUsableWidget(element, FILLABLE_TEXT_TYPES);
    },
    async buildTest(observation, element) {
      if (!element) return [];
      return buildFillAndMaybeSubmit(observation, element, "");
    },
  };
}
