import type { AppConfig } from "../config.js";
import type { ActionRisk, HeuristicRisk, InteractiveElement, Observation, QaAction, WidgetType } from "../types.js";

export interface QaHeuristic {
  id: string;
  name: string;
  appliesTo: WidgetType[];
  risk: HeuristicRisk;
  isApplicable(observation: Observation, element?: InteractiveElement): boolean;
  buildTest(observation: Observation, element?: InteractiveElement): Promise<QaAction[]>;
}

/** HeuristicRisk (a heuristic's own self-declared risk) is a distinct enum from ActionRisk (execution-time policy) — see §48-49. */
export function heuristicRiskToActionRisk(risk: HeuristicRisk): ActionRisk {
  return risk === "moderate" ? "state_changing" : risk;
}

import { createH01EmptyInput } from "./heuristics/h01-empty-input.js";
import { createH02Whitespace } from "./heuristics/h02-whitespace.js";
import { createH03LongText } from "./heuristics/h03-long-text.js";
import { createH04Unicode } from "./heuristics/h04-unicode.js";
import { createH05SpecialChars } from "./heuristics/h05-special-chars.js";
import { createH06NumericZero } from "./heuristics/h06-numeric-zero.js";
import { createH07NegativeNumeric } from "./heuristics/h07-negative-numeric.js";
import { createH08LargeNumeric } from "./heuristics/h08-large-numeric.js";
import { createH09ReloadState } from "./heuristics/h09-reload-state.js";
import { createH10DoubleSubmission } from "./heuristics/h10-double-submission.js";

export function allHeuristics(config: AppConfig): QaHeuristic[] {
  return [
    createH01EmptyInput(),
    createH02Whitespace(),
    createH03LongText(config),
    createH04Unicode(),
    createH05SpecialChars(),
    createH06NumericZero(),
    createH07NegativeNumeric(),
    createH08LargeNumeric(),
    createH09ReloadState(),
    createH10DoubleSubmission(config),
  ];
}
