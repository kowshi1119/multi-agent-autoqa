import type { QaHeuristic } from "../heuristics.js";
import { buildFillAndMaybeSubmit, FILLABLE_TEXT_TYPES, isUsableWidget } from "./support.js";

/** Validation testing with ordinary special characters — NOT an attack payload (no script tags, no SQL). */
export function createH05SpecialChars(): QaHeuristic {
  return {
    id: "H05",
    name: "Special characters",
    appliesTo: FILLABLE_TEXT_TYPES,
    risk: "safe",
    isApplicable(_observation, element) {
      return isUsableWidget(element, FILLABLE_TEXT_TYPES);
    },
    async buildTest(observation, element) {
      if (!element) return [];
      return buildFillAndMaybeSubmit(observation, element, "QA-Test_123!@#");
    },
  };
}
