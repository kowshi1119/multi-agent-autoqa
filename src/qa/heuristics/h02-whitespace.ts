import type { QaHeuristic } from "../heuristics.js";
import { buildFillAndMaybeSubmit, FILLABLE_TEXT_TYPES, isUsableWidget } from "./support.js";

/**
 * Leading/trailing whitespace around real content ("  test value  "),
 * observing accept/trim/reject/persist behavior. For a field the DOM marks
 * `required`, uses a pure-whitespace value instead — a required field that
 * silently accepts whitespace-only input as valid is a deterministic
 * validation defect the reload/oracle pipeline can catch (SEED-005).
 */
export function createH02Whitespace(): QaHeuristic {
  return {
    id: "H02",
    name: "Leading/trailing whitespace",
    appliesTo: FILLABLE_TEXT_TYPES,
    risk: "safe",
    isApplicable(_observation, element) {
      return isUsableWidget(element, FILLABLE_TEXT_TYPES);
    },
    async buildTest(observation, element) {
      if (!element) return [];
      const value = element.required ? "   " : "  test value  ";
      return buildFillAndMaybeSubmit(observation, element, value);
    },
  };
}
