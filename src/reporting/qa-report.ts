import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BudgetSnapshot } from "../budget.js";
import type { FindingGroup } from "../grouping/types.js";
import type { ApplicationMap } from "../mapping/types.js";
import type { Finding } from "../types.js";
import type { BenchmarkResult } from "./benchmark.js";
import type { Phase2Metrics } from "./phase2-metrics.js";

/** A raw Finding annotated with which group it landed in, if any -- report.json is the one artifact that reflects grouping; the Finding itself stays grouping-agnostic (see README's Cross-Finding Grouping section). */
export type ReportedFinding = Finding & { groupId?: string };

export const TRACE_POLICY_STATEMENT =
  "Validator trace capture (Phase 3 policy, reverses Phase 0/2's attempt-1-only rule): evidence is captured from the first attempt that actually reproduces the original finding's failure signature, not always attempt 1. When no attempt reproduces, evidence is captured from the last attempt and labeled diagnostic-no-success. Exactly one trace.zip and one screenshot.png are still persisted per finding regardless of how many attempts ran.";

export type QaReport = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "failed";
  stopReason?: string;
  target: { url: string; environment: string };
  provider: { name: string; model?: string };
  applicationMap: ApplicationMap;
  coverage: {
    pagesDiscovered: number;
    pagesVisited: number;
    interactiveControlsDiscovered: number;
    heuristicsApplicable: number;
    heuristicsExecuted: number;
    heuristicCoverage: number;
  };
  findings: ReportedFinding[];
  /** Only groups that were actually formed (2+ members) -- empty when grouping is disabled or nothing merged. */
  groups: FindingGroup[];
  oracleBreakdown: Record<string, number>;
  reportDispositionBreakdown: { report: number; suppress: number; needs_human: number };
  budget: BudgetSnapshot;
  tracePolicy: string;
  benchmark?: BenchmarkResult;
  /** Only present when target.environment === "local-fixture" and models.critic.enabled -- the detection/final-report comparison this whole phase exists to make (see reporting/phase2-metrics.ts). */
  phase2?: Phase2Metrics;
  safetyEventCount: number;
  errorClassification?: string;
};

/** Validated-findings-only, by oracleId. */
export function buildOracleBreakdown(findings: Finding[]): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const finding of findings) {
    if (finding.status !== "validated") continue;
    breakdown[finding.oracle.oracleId] = (breakdown[finding.oracle.oracleId] ?? 0) + 1;
  }
  return breakdown;
}

export function writeReportJson(runDir: string, report: QaReport): void {
  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf-8");
}

/** Pure string templating over already-computed QaReport data — no model call. */
export function buildReportMarkdown(report: QaReport): string {
  const lines: string[] = [];
  const validated = report.findings.filter((f) => f.status === "validated").length;
  const rejected = report.findings.filter((f) => f.status === "rejected").length;
  const needsHuman = report.findings.filter((f) => f.status === "needs_human").length;

  lines.push("# AutoQA Run Report", "");

  lines.push("## Summary", "");
  lines.push(`Run ID: ${report.runId}`, "");
  lines.push(`Target: ${report.target.url} (${report.target.environment})`, "");
  lines.push(`Provider: ${report.provider.name}${report.provider.model ? ` (${report.provider.model})` : ""}`, "");
  lines.push(`Status: ${report.status}${report.stopReason ? ` — ${report.stopReason}` : ""}`, "");
  lines.push(`Pages visited: ${report.coverage.pagesVisited} (of ${report.coverage.pagesDiscovered} discovered)`, "");
  lines.push(`Heuristics executed: ${report.coverage.heuristicsExecuted}`, "");
  lines.push(`Validated defects: ${validated}`, "");
  lines.push(`Rejected findings: ${rejected}`, "");
  lines.push(`Needs human review: ${needsHuman}`, "");

  lines.push("## Findings", "");
  if (report.findings.length === 0) {
    lines.push("_No findings suspected during this run._", "");
  } else {
    for (const finding of report.findings) {
      lines.push(`### ${finding.id}`, "");
      lines.push(finding.title, "");
      lines.push(`Status: ${finding.status}`, "");
      lines.push(`Reproduction: ${finding.reproduction.successes}/${finding.reproduction.attempts}`, "");
      lines.push(`Oracle: ${finding.oracle.oracleId}`, "");
      lines.push(`Page: ${finding.pathname} (${finding.pageId})`, "");
      lines.push(`Occurrences: ${finding.occurrenceCount}`, "");
      if (finding.groupId) lines.push(`Group: ${finding.groupId}`, "");
      lines.push("");
    }
  }

  lines.push("## Coverage", "");
  lines.push(
    `Heuristic coverage: ${report.coverage.heuristicsExecuted}/${report.coverage.heuristicsApplicable}` +
      ` (${(report.coverage.heuristicCoverage * 100).toFixed(1)}%) — heuristic coverage, not application test coverage.`,
    ""
  );
  lines.push(`Interactive controls discovered: ${report.coverage.interactiveControlsDiscovered}`, "");

  lines.push("## Oracle breakdown (validated findings)", "");
  const oracleIds = Object.keys(report.oracleBreakdown);
  if (oracleIds.length === 0) {
    lines.push("_None._", "");
  } else {
    for (const id of oracleIds) lines.push(`- ${id}: ${report.oracleBreakdown[id]}`);
    lines.push("");
  }

  lines.push("## Budget usage", "");
  const b = report.budget;
  lines.push(`Actions: ${b.actionsUsed}/${b.maxActions}`, "");
  lines.push(`Model calls: ${b.modelCallsUsed}/${b.maxModelCalls}`, "");
  lines.push(`Pages: ${b.pagesUsed}/${b.maxPages}`, "");
  lines.push(`Findings: ${b.findingsUsed}/${b.maxFindings}`, "");
  lines.push(`Duration: ${b.durationMs}ms / ${b.maxDurationMs}ms`, "");

  lines.push("## Safety", "");
  lines.push(`Safety events recorded: ${report.safetyEventCount}`, "");

  lines.push("## Report disposition (all findings)", "");
  const rd = report.reportDispositionBreakdown;
  lines.push(`Report: ${rd.report}`, "");
  lines.push(`Suppress: ${rd.suppress}`, "");
  lines.push(`Needs human: ${rd.needs_human}`, "");

  if (report.benchmark) {
    lines.push("## Benchmark (local fixture, detection level)", "");
    const bm = report.benchmark;
    lines.push(`Matched on: ${bm.matchedOn}`, "");
    lines.push(`Seeded defects: ${bm.seededDefects}`, "");
    lines.push(`True positives: ${bm.truePositives.length}`, "");
    lines.push(`False positives: ${bm.falsePositives.length}`, "");
    lines.push(`False negatives: ${bm.falseNegatives.length}`, "");
    lines.push(`Precision: ${bm.precision.toFixed(3)}`, "");
    lines.push(`Recall: ${bm.recall.toFixed(3)}`, "");
    lines.push(`F1: ${bm.f1.toFixed(3)}`, "");
  }

  if (report.phase2) {
    lines.push("## Phase 2 — critic effectiveness", "");
    lines.push(
      "Detection asks \"did AutoQA find every seeded defect?\"; final-report asks \"of what AutoQA found, how much would a human actually see reported?\" -- the same matcher, run against two different filters of the same findings (validated vs reportDisposition===\"report\").",
      ""
    );
    const p2 = report.phase2;
    lines.push(
      `Detection: precision ${p2.detection.precision.toFixed(3)} / recall ${p2.detection.recall.toFixed(3)} / F1 ${p2.detection.f1.toFixed(3)} (${p2.detection.falsePositives.length} false positives)`,
      ""
    );
    lines.push(
      `Final report: precision ${p2.finalReport.precision.toFixed(3)} / recall ${p2.finalReport.recall.toFixed(3)} / F1 ${p2.finalReport.f1.toFixed(3)} (${p2.finalReport.falsePositives.length} false positives)`,
      ""
    );
    lines.push(`False positives suppressed by critic: ${p2.falsePositivesSuppressed}`, "");
    lines.push(`False positive reduction rate: ${(p2.falsePositiveReductionRate * 100).toFixed(1)}%`, "");
    lines.push(`Recall lost to critic suppression: ${(p2.recallLoss * 100).toFixed(1)}%`, "");
  }

  if (report.groups.length > 0) {
    lines.push("## Cross-finding grouping", "");
    lines.push(
      "Groups below are evidence-supported duplicate manifestations of the same underlying defect -- never a claim of a proven, single source-code root cause.",
      ""
    );
    const findingsGrouped = report.groups.reduce((sum, g) => sum + g.memberFindingIds.length, 0);
    lines.push(`Groups formed: ${report.groups.length}`, "");
    lines.push(`Duplicate excess (findings grouped minus groups formed): ${findingsGrouped - report.groups.length}`, "");
    for (const group of report.groups) {
      lines.push(
        `- ${group.groupId}: canonical ${group.canonicalFindingId}, members [${group.memberFindingIds.join(", ")}]${group.dispositionConflict ? " (disposition conflict)" : ""} -- ${group.reason}`
      );
    }
    lines.push("");
  }

  lines.push("## Evidence policy", "");
  lines.push(report.tracePolicy, "");

  if (report.errorClassification) {
    lines.push("## Error", "");
    lines.push(report.errorClassification, "");
  }

  return lines.join("\n");
}

export function writeReportMarkdown(runDir: string, markdown: string): void {
  writeFileSync(join(runDir, "report.md"), markdown, "utf-8");
}
