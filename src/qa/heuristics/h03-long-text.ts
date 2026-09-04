import type { AppConfig } from "../../config.js";
import type { QaHeuristic } from "../heuristics.js";
import { buildFillAndMaybeSubmit, FILLABLE_TEXT_TYPES, isUsableWidget } from "./support.js";

/** Fills a safe, configurable boundary length of text (default 500 chars — never attack-scale). */
export function createH03LongText(config: AppConfig): QaHeuristic {
  return {
    id: "H03",
    name: "Very long text",
    appliesTo: FILLABLE_TEXT_TYPES,
    risk: "safe",
    isApplicable(_observation, element) {
      return isUsableWidget(element, FILLABLE_TEXT_TYPES);
    },
    async buildTest(observation, element) {
      if (!element) return [];
      const value = "A".repeat(config.heuristics.longTextBoundaryChars);
      return buildFillAndMaybeSubmit(observation, element, value);
    },
  };
}
