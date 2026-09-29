import { REASON_LABELS } from "../outcomes/outcome.js";
import type { CoverageComparison, RequirementCoverage } from "../requirements-coverage/coverage.js";
import type { SuiteComparison } from "../suites/compare.js";
import { verdictOf, type SuiteResult } from "../suites/result.js";

/**
 * The QA coverage report for one suite run: every conclusion names its run,
 * requirement revision, assertion identity and run-relative evidence files.
 * It contains assertion expectations and sanitized observations only, never
 * response bodies or other application data.
 */
export type CoverageReport = ReturnType<typeof buildCoverageReport>;

const STATEMENT = "This report covers only the selected suite and the approved requirements linked to it. A PASS does not mean the application is secure, defect-free, or that all business requirements are tested.";

export function buildCoverageReport(input: { result: SuiteResult; comparison?: SuiteComparison; coverage?: RequirementCoverage; coverageComparison?: CoverageComparison }) {
  const { result, comparison, coverage, coverageComparison } = input;
  const assertionsWhere = (kind: string, predicate: (id: string, verdict: string) => boolean) => result.items.filter((i) => i.kind === kind).flatMap((i) => i.assertions
    .filter((a) => predicate(a.id, verdictOf(a)))
    .map((a) => ({ identity: a.identity, required: i.required, assertion: a.assertion, expected: a.expected, observed: a.observed, verdict: verdictOf(a), ...(a.reasonCode ? { reasonCode: a.reasonCode } : {}), ...(a.confidence ? { confidence: a.confidence } : {}), ...(a.limitations ? { limitations: a.limitations } : {}), ...(a.severityRationale ? { severityRationale: a.severityRationale } : {}), evidenceRefs: i.evidenceRefs })));
  return {
    schemaVersion: 1 as const,
    runId: result.runId,
    generatedAt: new Date().toISOString(),
    application: { profileId: result.profileId, origin: result.target.origin, environment: result.target.environmentKind, authMode: result.target.authMode },
    suite: { id: result.suite.id, name: result.suite.name, revision: result.suite.revision },
    statement: STATEMENT,
    decision: { value: result.decision, reason: result.decisionReason, scope: result.scope, coverageGaps: result.coverageGaps },
    requirementCoverage: coverage ? {
      label: coverage.label,
      mappingRules: coverage.mappingRules,
      summary: coverage.summary,
      draftsExcluded: coverage.draftsExcluded,
      requirements: coverage.requirements.map((r) => ({ requirementId: r.requirementId, revision: r.revision, title: r.title, importance: r.importance, status: r.status, reason: r.reason, criteria: r.criteria.map((c) => ({ identity: c.identity, description: c.description, required: c.required, status: c.status, reason: c.reason, links: c.links.map((l) => ({ identity: l.identity, status: l.status, ...(l.expected !== undefined ? { expected: l.expected } : {}), ...(l.observed !== undefined ? { observed: l.observed } : {}), ...(l.reasonCode ? { reasonCode: l.reasonCode } : {}), evidenceRefs: l.evidenceRefs })) })) })),
    } : null,
    newlyFailingCriteria: (coverageComparison?.entries ?? []).filter((e) => e.change === "newly-failing"),
    newlyFailingAssertions: (comparison?.entries ?? []).filter((e) => e.category === "newly-failing").map((e) => ({ identity: e.identity, required: e.required, expected: e.expected, observed: e.observed, baselineObserved: e.baselineObserved, reproduction: e.reproduction, evidenceRefs: e.evidenceRefs })),
    comparison: comparison ? { comparable: comparison.comparable, reason: comparison.reason ?? null, baselineRunId: comparison.baseline?.runId ?? null, counts: comparison.counts, notes: comparison.notes } : null,
    contractMismatches: assertionsWhere("api-check", (id, v) => id.startsWith("contract:") && v === "fail"),
    contractNotValidated: assertionsWhere("api-check", (id, v) => id.startsWith("contract:") && (v === "unsupported" || v === "not-assessed")),
    securityPolicyFindings: assertionsWhere("security-check", (_id, v) => v === "fail"),
    securityNotAssessed: assertionsWhere("security-check", (_id, v) => v === "unsupported" || v === "not-assessed"),
    executionFailures: result.items.filter((i) => i.status === "not-executed" || i.status === "unsupported").map((i) => ({ identity: i.identity, required: i.required, status: i.status, reasonCode: i.reasonCode ?? "legacy-unknown", reasonLabel: REASON_LABELS[i.reasonCode ?? "legacy-unknown"], explanation: i.reason })),
    unassessed: [
      ...(coverage?.requirements ?? []).flatMap((r) => r.criteria.filter((c) => c.status !== "passed" && c.status !== "failed").map((c) => ({ identity: `${c.identity}@rev${r.revision}`, required: c.required, status: c.status, reason: c.reason }))),
      ...result.coverageGaps.map((g) => ({ identity: g.identity, required: true, status: g.status, reason: g.reason })),
    ],
    accounting: result.accounting,
  };
}

const esc = (text: unknown): string => String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderCoverageReportMarkdown(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push(`# QA coverage report — ${esc(report.suite.name)} rev ${report.suite.revision}`, "");
  lines.push(`Run \`${report.runId}\` · ${esc(report.application.origin)} (${esc(report.application.environment)}) · generated ${report.generatedAt}`, "");
  lines.push(`> ${report.statement}`, "");
  lines.push(`## Decision: ${report.decision.value}`, "", esc(report.decision.reason), "", esc(report.decision.scope), "");
  if (report.decision.coverageGaps.length) {
    lines.push("Missing required coverage:", "");
    for (const g of report.decision.coverageGaps) lines.push(`- \`${g.identity}\` — ${g.status}${g.reasonCode ? ` (${g.reasonCode})` : ""}: ${esc(g.reason)}`);
    lines.push("");
  }
  lines.push("## Declared requirement coverage", "");
  if (!report.requirementCoverage) lines.push("No approved requirements for this application.", "");
  else {
    const s = report.requirementCoverage.summary;
    lines.push(esc(report.requirementCoverage.label), "");
    lines.push(`- Requirements passed: ${s.requirementsPassed.numerator} of ${s.requirementsPassed.denominator} approved (${s.requirementsPassed.percent ?? "n/a"}%)`);
    lines.push(`- Required criteria with valid pass/fail evidence: ${s.requiredCriteriaAssessed.numerator} of ${s.requiredCriteriaAssessed.denominator} (${s.requiredCriteriaAssessed.percent ?? "n/a"}%)`);
    lines.push(`- Drafts excluded: ${report.requirementCoverage.draftsExcluded}`, "");
    lines.push("| Requirement | Rev | Importance | Status | Criteria |", "|---|---|---|---|---|");
    for (const r of report.requirementCoverage.requirements) lines.push(`| ${esc(r.requirementId)} ${esc(r.title)} | ${r.revision} | ${r.importance} | ${r.status} | ${r.criteria.map((c) => `${esc(c.identity)}${c.required ? "" : " (optional)"}: ${c.status}`).join("<br>")} |`);
    lines.push("", "Mapping rules:", "", ...report.requirementCoverage.mappingRules.map((rule) => `- ${esc(rule)}`), "");
  }
  const section = (title: string, rows: string[], empty: string) => { lines.push(`## ${title}`, ""); lines.push(...(rows.length ? rows : [empty]), ""); };
  section("Newly failing criteria", report.newlyFailingCriteria.map((e) => `- \`${e.identity}\`: ${e.baseline} → ${e.current}`), report.comparison?.comparable ? "None." : `Not compared: ${esc(report.comparison?.reason ?? "no baseline")}`);
  section("Newly failing assertions", report.newlyFailingAssertions.map((e) => `- \`${e.identity}\`: expected ${esc(e.expected)}, observed ${esc(e.observed)} (baseline ${esc(e.baselineObserved)})${e.reproduction ? ` — ${esc(e.reproduction)}` : ""}. Evidence: ${e.evidenceRefs.join(", ")}`), report.comparison?.comparable ? "None." : `Not compared: ${esc(report.comparison?.reason ?? "no baseline")}`);
  section("API contract mismatches", report.contractMismatches.map((m) => `- \`${m.identity}\`: expected ${esc(m.expected)}, observed ${esc(m.observed)}${m.reasonCode === "malformed-response" ? " (malformed response)" : ""}. Evidence: ${m.evidenceRefs.join(", ")}`), "None.");
  section("Contract assertions not validated", report.contractNotValidated.map((m) => `- \`${m.identity}\`: ${m.verdict} — ${esc(m.observed)}`), "None.");
  section("Security policy findings (declared policy not met; not a demonstrated vulnerability unless stated)", report.securityPolicyFindings.map((f) => `- \`${f.identity}\`: expected ${esc(f.expected)}, observed ${esc(f.observed)}. Confidence ${f.confidence ?? "n/a"}. ${esc(f.severityRationale ?? "")} Limitations: ${esc(f.limitations ?? "")} Evidence: ${f.evidenceRefs.join(", ")}`), "None.");
  section("Security assertions not assessed", report.securityNotAssessed.map((f) => `- \`${f.identity}\`: ${esc(f.observed)} — ${esc(f.limitations ?? "")}`), "None.");
  section("Execution and configuration failures", report.executionFailures.map((f) => `- \`${f.identity}\`${f.required ? " [required]" : ""}: ${f.status} — ${f.reasonCode} (${esc(f.reasonLabel)}): ${esc(f.explanation)}`), "None.");
  section("Unassessed areas", report.unassessed.map((u) => `- \`${u.identity}\`${u.required ? " [required]" : ""}: ${u.status} — ${esc(u.reason)}`), "None.");
  lines.push("## Usage", "", `Browser actions ${report.accounting.browserActions} · HTTP check requests ${report.accounting.httpCheckRequests} · model decisions ${report.accounting.modelDecisions} · external model requests ${report.accounting.externalModelRequests}`, "");
  return lines.join("\n");
}
