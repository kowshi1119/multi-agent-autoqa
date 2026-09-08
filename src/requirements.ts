import { readFileSync } from "node:fs";
import type { RequirementContext, RequirementRule } from "./types.js";

export class RequirementContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementContextError";
  }
}

type RequirementsFile = { rules: RequirementRule[] };

/**
 * Requirements answer "what behavior is expected?" -- distinct from the
 * fixture's seeded-defect answer key file, which answers "which seeded
 * defects exist?" and must never reach the Explorer/Critic/Planner/
 * Oracles/Validator (enforced by a security test covering this file).
 * Requirements MAY be
 * scoped to the Critic (and, if configured, the Explorer); missing or
 * unparseable requirements degrade gracefully to an empty list rather
 * than failing the run -- a QA context file being absent isn't a reason
 * to abort testing.
 */
export function loadRequirements(path: string): RequirementRule[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RequirementContextError(
      `REQUIREMENT_CONTEXT_ERROR: invalid JSON in ${path}\n${error instanceof Error ? error.message : String(error)}`
    );
  }

  const file = parsed as Partial<RequirementsFile>;
  if (!Array.isArray(file.rules)) {
    throw new RequirementContextError(`REQUIREMENT_CONTEXT_ERROR: ${path} must contain a top-level "rules" array.`);
  }

  return file.rules;
}

/**
 * Never send every requirement to every call -- filter by pathname before
 * handing anything to a model. The hint fields (triggerRequestPathname/
 * expectedVisibleText) stay in the scoped result: they're general
 * behavioral facts, not a seeded-defect answer key (that lives in a
 * structurally separate file/type entirely).
 */
export function scopeRequirements(rules: RequirementRule[], pathname: string): RequirementContext[] {
  return rules.filter((rule) => rule.pathname === pathname);
}
