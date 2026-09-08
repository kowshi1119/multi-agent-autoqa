import type { AppConfig } from "../../config.js";
import type { InteractiveElement, QaAction } from "../../types.js";
import type { QaHeuristic } from "../heuristics.js";
import { isUsableWidget, toElementTarget } from "./support.js";

const DESTRUCTIVE_KEYWORDS = [
  "delete",
  "remove",
  "pay",
  "transfer",
  "logout",
  "log out",
  "sign out",
  "cancel",
  "unsubscribe",
  "deactivate",
  "purchase",
  "checkout",
  "confirm",
];

/**
 * Defense-in-depth, not a security boundary: a plain-text keyword filter is
 * trivially bypassed by an ambiguous label. It is combined with the
 * environment/allowlist gate below (never runs outside the local fixture
 * unless the control is explicitly allowlisted), so a misclassified name
 * can never fire against a real target.
 */
function looksDestructive(element: InteractiveElement): boolean {
  const name = (element.name ?? element.label ?? "").toLowerCase();
  return DESTRUCTIVE_KEYWORDS.some((keyword) => name.includes(keyword));
}

function isAllowlisted(config: AppConfig, element: InteractiveElement): boolean {
  const name = element.name ?? element.label;
  return Boolean(name) && config.heuristics.safeControlClick.allowedControls.includes(name as string);
}

/**
 * Exercises a generic `<button type="button">` the way a QA tester would
 * click any visible, enabled control -- not just submit buttons (H10's
 * territory) or fillable fields (H01-H09's territory). This closes the
 * exploration gap Phase 1 documented (an uncaught runtime error behind a
 * plain button with no associated fillable field) without ever hardcoding
 * a reference to any specific control: applicability is purely
 * widget-type + safety-keyword + environment/allowlist gating, so any
 * future plain-button defect anywhere in the app is reachable the same
 * way, not just the one this closes.
 */
export function createH11SafeControl(config: AppConfig): QaHeuristic {
  return {
    id: "H11",
    name: "Safe control activation",
    appliesTo: ["button"],
    risk: "safe",
    isApplicable(_observation, element) {
      if (!config.heuristics.safeControlClick.enabled || !config.safety.safeMode) return false;
      if (!isUsableWidget(element, ["button"])) return false;
      if (looksDestructive(element)) return false;
      if (config.target.environment === "local-fixture") return true;
      return isAllowlisted(config, element);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async buildTest(_observation, element) {
      if (!element) return [];
      const actions: QaAction[] = [{ type: "click", target: toElementTarget(element) }];
      return actions;
    },
  };
}
