import type { ReasonCode } from "../outcomes/outcome.js";
import type { SuiteResult } from "../suites/result.js";
import { verdictOf } from "../suites/result.js";
import type { Requirement } from "./requirements.js";

/**
 * Coverage of *declared, approved* requirements by one suite run. Mapping rules
 * (also written into every coverage artifact):
 *  - a criterion with no links is "not assessed (unmapped)";
 *  - a link whose item definition changed since the requirement was approved is "incomparable";
 *  - a link to an item outside this suite, or an item that was not executed, is "not assessed";
 *  - a linked assertion that failed makes the criterion "failed"; unsupported assertions make it "unsupported";
 *  - a criterion "passed" only when every linked assertion reported a valid pass
 *    (a click or a page visit alone is never evidence: only assertion verdicts count);
 *  - a requirement "passed" only when every *required* criterion passed.
 * Draft requirements are excluded. None of this is coverage of the whole application.
 */
export type CoverageStatus = "passed" | "failed" | "partially-assessed" | "not-assessed" | "unsupported" | "incomparable";

export const MAPPING_RULES = [
  "Only approved requirements are counted; drafts are excluded.",
  "A criterion passes only when every linked assertion reported a valid pass in this run; clicks and page visits are not evidence.",
  "A criterion with no linked assertion is not assessed (unmapped).",
  "A linked item outside this suite, or not executed in this run, is not assessed.",
  "A linked item whose definition changed after the requirement was approved is incomparable.",
  "A requirement passes only when all of its required criteria pass.",
  "Percentages describe declared requirements only, not the whole application.",
];

export type LinkResult = { identity: string; status: CoverageStatus; reason: string; reasonCode?: ReasonCode; expected?: string; observed?: string; evidenceRefs: string[] };
export type CriterionResult = { identity: string; criterionId: string; description: string; required: boolean; status: CoverageStatus; reason: string; links: LinkResult[] };
export type RequirementResult = { requirementId: string; revision: number; title: string; importance: Requirement["importance"]; status: CoverageStatus; reason: string; criteria: CriterionResult[] };
export type RequirementCoverage = {
  schemaVersion: 1;
  runId: string;
  suite: { id: string; revision: number };
  label: string;
  mappingRules: string[];
  requirements: RequirementResult[];
  summary: {
    approvedRequirements: number;
    byStatus: Record<CoverageStatus, number>;
    requiredCriteria: number;
    requiredCriteriaWithEvidence: number;
    requiredCriteriaPassed: number;
    /** "passed / approved requirements" and "required criteria with a valid pass or fail / required criteria", each with its denominator. */
    requirementsPassed: { numerator: number; denominator: number; percent: number | null };
    requiredCriteriaAssessed: { numerator: number; denominator: number; percent: number | null };
  };
  draftsExcluded: number;
};

const STATUSES: CoverageStatus[] = ["passed", "failed", "partially-assessed", "not-assessed", "unsupported", "incomparable"];

function combine(statuses: CoverageStatus[]): CoverageStatus {
  if (!statuses.length) return "not-assessed";
  if (statuses.includes("incomparable")) return "incomparable";
  if (statuses.includes("failed")) return "failed";
  if (statuses.every((s) => s === "passed")) return "passed";
  if (statuses.some((s) => s === "passed" || s === "partially-assessed")) return "partially-assessed";
  if (statuses.every((s) => s === "unsupported")) return "unsupported";
  return "not-assessed";
}

function linkResult(link: Requirement["criteria"][number]["links"][number], result: SuiteResult): LinkResult {
  const identity = `${link.kind}:${link.itemId}#${link.assertionId}`;
  const item = result.items.find((i) => i.kind === link.kind && i.itemId === link.itemId);
  if (!item) return { identity, status: "not-assessed", reason: "The linked item is not part of this suite.", evidenceRefs: [] };
  if (link.definitionHash && link.definitionHash !== item.definitionHash) return { identity, status: "incomparable", reason: "The linked item's definition changed after the requirement was approved; review and re-approve the requirement.", evidenceRefs: item.evidenceRefs };
  if (item.status === "not-executed" || (item.status === "unsupported" && !item.assertions.length)) {
    return { identity, status: item.status === "unsupported" ? "unsupported" : "not-assessed", reason: item.reason, ...(item.reasonCode ? { reasonCode: item.reasonCode } : {}), evidenceRefs: item.evidenceRefs };
  }
  const assertions = link.assertionId === "*" ? item.assertions : item.assertions.filter((a) => a.id === link.assertionId);
  if (!assertions.length) return { identity, status: "not-assessed", reason: "The linked assertion was not reported in this run.", evidenceRefs: item.evidenceRefs };
  const verdicts = assertions.map(verdictOf);
  const status: CoverageStatus = verdicts.includes("fail") ? "failed" : verdicts.every((v) => v === "pass") ? "passed" : verdicts.some((v) => v === "pass") ? "partially-assessed" : verdicts.every((v) => v === "unsupported") ? "unsupported" : "not-assessed";
  const failing = assertions.filter((a) => verdictOf(a) === "fail");
  const shown = failing[0] ?? assertions.find((a) => verdictOf(a) !== "pass") ?? assertions[0]!;
  return {
    identity,
    status,
    reason: status === "passed" ? `${assertions.length} linked assertion(s) passed.` : failing.length ? `${failing.length} linked assertion(s) failed.` : `${assertions.filter((a) => verdictOf(a) !== "pass").length} linked assertion(s) not assessed or unsupported.`,
    expected: shown.expected,
    observed: shown.observed,
    evidenceRefs: item.evidenceRefs,
  };
}

export function computeRequirementCoverage(requirements: Requirement[], result: SuiteResult): RequirementCoverage {
  const approved = requirements.filter((r) => r.status === "approved");
  const results: RequirementResult[] = approved.map((req) => {
    const criteria: CriterionResult[] = req.criteria.map((c) => {
      const links = c.links.map((l) => linkResult(l, result));
      const status = links.length ? combine(links.map((l) => l.status)) : "not-assessed";
      return { identity: `${req.id}#${c.id}`, criterionId: c.id, description: c.description, required: c.required, status, reason: links.length ? links.map((l) => `${l.identity}: ${l.status}${l.status === "passed" ? "" : ` — ${l.reason}`}`).join("; ") : "Unmapped: no assertion is linked to this criterion.", links };
    });
    const required = criteria.filter((c) => c.required);
    const status: CoverageStatus = required.length ? combine(required.map((c) => c.status)) : "not-assessed";
    return { requirementId: req.id, revision: req.revision, title: req.title, importance: req.importance, status, reason: required.length ? `${required.filter((c) => c.status === "passed").length} of ${required.length} required criteria passed.` : "No required criteria.", criteria };
  });
  const requiredCriteria = results.flatMap((r) => r.criteria.filter((c) => c.required));
  const withEvidence = requiredCriteria.filter((c) => c.status === "passed" || c.status === "failed").length;
  const passedReqs = results.filter((r) => r.status === "passed").length;
  const pct = (n: number, d: number) => d ? Math.round((n / d) * 1000) / 10 : null;
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, results.filter((r) => r.status === s).length])) as Record<CoverageStatus, number>;
  return {
    schemaVersion: 1,
    runId: result.runId,
    suite: { id: result.suite.id, revision: result.suite.revision },
    label: "Coverage of declared, approved requirements by this suite run — not coverage of the entire application.",
    mappingRules: MAPPING_RULES,
    requirements: results,
    summary: {
      approvedRequirements: results.length,
      byStatus,
      requiredCriteria: requiredCriteria.length,
      requiredCriteriaWithEvidence: withEvidence,
      requiredCriteriaPassed: requiredCriteria.filter((c) => c.status === "passed").length,
      requirementsPassed: { numerator: passedReqs, denominator: results.length, percent: pct(passedReqs, results.length) },
      requiredCriteriaAssessed: { numerator: withEvidence, denominator: requiredCriteria.length, percent: pct(withEvidence, requiredCriteria.length) },
    },
    draftsExcluded: requirements.length - approved.length,
  };
}

export type CriterionChange = "newly-failing" | "still-failing" | "fixed" | "unchanged-passing" | "added" | "removed" | "not-assessed" | "incomparable";
export type CoverageComparison = {
  baselineRunId: string | null;
  comparable: boolean;
  reason?: string;
  entries: Array<{ identity: string; requirementId: string; change: CriterionChange; required: boolean; current?: CoverageStatus; baseline?: CoverageStatus; reason?: string }>;
};

/** Criterion-level comparison by identity `<requirement>#<criterion>`; a changed requirement revision is incomparable, never compared. */
export function compareCoverage(current: RequirementCoverage, baseline: RequirementCoverage | undefined, baselineRunId: string | null): CoverageComparison {
  if (!baseline) return { baselineRunId, comparable: false, reason: baselineRunId ? "The baseline run has no requirement coverage record." : "No approved baseline for this suite.", entries: [] };
  const entries: CoverageComparison["entries"] = [];
  const beforeReqs = new Map(baseline.requirements.map((r) => [r.requirementId, r]));
  for (const req of current.requirements) {
    const prior = beforeReqs.get(req.requirementId);
    for (const c of req.criteria) {
      const base = { identity: c.identity, requirementId: req.requirementId, required: c.required, current: c.status };
      if (!prior) { entries.push({ ...base, change: "added", reason: "Requirement not approved at the time of the baseline." }); continue; }
      if (prior.revision !== req.revision) { entries.push({ ...base, change: "incomparable", reason: `Requirement changed from revision ${prior.revision} to ${req.revision}; its criteria are not compared.` }); continue; }
      const before = prior.criteria.find((p) => p.criterionId === c.criterionId);
      if (!before) { entries.push({ ...base, change: "added" }); continue; }
      const withBase = { ...base, baseline: before.status };
      if (c.status === "incomparable" || before.status === "incomparable") { entries.push({ ...withBase, change: "incomparable", reason: "A linked definition changed." }); continue; }
      if (c.status !== "passed" && c.status !== "failed") { entries.push({ ...withBase, change: "not-assessed", reason: "No valid pass/fail evidence in this run; not a pass and not a regression." }); continue; }
      if (before.status !== "passed" && before.status !== "failed") { entries.push({ ...withBase, change: "added", reason: "The baseline had no pass/fail evidence for this criterion." }); continue; }
      entries.push({ ...withBase, change: c.status === "passed" ? (before.status === "passed" ? "unchanged-passing" : "fixed") : before.status === "passed" ? "newly-failing" : "still-failing" });
    }
  }
  for (const prior of baseline.requirements) {
    if (!current.requirements.some((r) => r.requirementId === prior.requirementId)) {
      for (const c of prior.criteria) entries.push({ identity: c.identity, requirementId: prior.requirementId, required: c.required, change: "removed", baseline: c.status, reason: "Requirement no longer approved." });
    }
  }
  const order: CriterionChange[] = ["newly-failing", "still-failing", "not-assessed", "incomparable", "fixed", "added", "removed", "unchanged-passing"];
  entries.sort((a, b) => order.indexOf(a.change) - order.indexOf(b.change) || a.identity.localeCompare(b.identity));
  return { baselineRunId, comparable: true, entries };
}
