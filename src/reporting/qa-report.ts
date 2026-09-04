import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BudgetSnapshot } from "../budget.js";
import type { ApplicationMap } from "../mapping/types.js";
import type { Finding } from "../types.js";
import type { BenchmarkResult } from "./benchmark.js";

export const TRACE_POLICY_STATEMENT =
  "Validator trace capture: first replay attempt only. Screenshot, console, and network evidence may be captured according to the existing evidence policy.";

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
  findings: Finding[];
  oracleBreakdown: Record<string, number>;
  budget: BudgetSnapshot;
  tracePolicy: string;
  benchmark?: BenchmarkResult;
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

  if (report.benchmark) {
    lines.push("## Benchmark (local fixture)", "");
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
