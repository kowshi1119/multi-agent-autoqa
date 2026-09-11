import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { AppConfig } from "../config.js";
import { groupFindings } from "../grouping/group-findings.js";
import type { GroupingResult } from "../grouping/types.js";
import { normalizePathname } from "../mapping/state-signature.js";
import { estimateRunCostUsd } from "../models/pricing.js";
import { writeRunSummary, type RunSummary } from "../report.js";
import type { PipelineResult } from "../run-pipeline.js";
import type { Finding } from "../types.js";
import { loadGroundTruth, matchFindings } from "./benchmark.js";
import { computeHeuristicCoverage } from "./coverage.js";
import { computePhase2Metrics } from "./phase2-metrics.js";
import {
  buildOracleBreakdown,
  buildReportMarkdown,
  writeReportJson,
  writeReportMarkdown,
  TRACE_POLICY_STATEMENT,
  type QaReport,
  type ReportedFinding,
} from "./qa-report.js";

/**
 * One representative per group plus every ungrouped finding -- what
 * grouping's OWN benchmark effect is measured against, isolated from the
 * raw detection-level and final-report-level numbers (see grouping.json).
 * Exported (was a private helper in index.ts) so a UI/report consumer can
 * compute the same canonical/deduplicated count the CLI does, rather than
 * reimplementing group-membership logic a second time.
 */
export function canonicalFindingsOnly(findings: Finding[], grouping: GroupingResult): Finding[] {
  const canonicalIds = new Set(grouping.groups.map((g) => g.canonicalFindingId));
  return findings.filter((f) => grouping.ungrouped.includes(f.id) || canonicalIds.has(f.id));
}

function annotateWithGroupIds(findings: Finding[], grouping: GroupingResult): ReportedFinding[] {
  const groupIdByFinding = new Map<string, string>();
  for (const group of grouping.groups) {
    for (const memberId of group.memberFindingIds) groupIdByFinding.set(memberId, group.groupId);
  }
  return findings.map((f) => ({ ...f, ...(groupIdByFinding.has(f.id) ? { groupId: groupIdByFinding.get(f.id) } : {}) }));
}

export function reportDispositionBreakdown(findings: Finding[]): { report: number; suppress: number; needs_human: number } {
  const breakdown = { report: 0, suppress: 0, needs_human: 0 };
  for (const finding of findings) breakdown[finding.reportDisposition] += 1;
  return breakdown;
}

/** "FAILED"/"CANCELLED" are both terminal-but-not-COMPLETE orchestrator states; everything else that reached here completed normally. */
function statusFor(orchestratorState: string): RunSummary["status"] {
  if (orchestratorState === "FAILED") return "failed";
  if (orchestratorState === "CANCELLED") return "cancelled";
  return "completed";
}

export type AssembledReport = { summary: RunSummary; report: QaReport };

/**
 * Everything `runPipeline()` (src/run-pipeline.ts) alone does NOT produce:
 * grouping, coverage/summary assembly, ground-truth-gated benchmarking,
 * and final QaReport construction -- extracted verbatim from
 * `src/index.ts#main()`'s previous inline body (Phase 4 Milestone B) so
 * the CLI and the UI's RunManager (src/run-manager.ts) call the exact same
 * function rather than each hand-rolling this assembly a second time. Pure
 * aside from the same `writeFileSync`/`writeRunSummary`/`writeReportJson`
 * calls the CLI already made -- both callers want the artifacts on disk
 * identically.
 */
export function assembleReport(
  pipelineResult: PipelineResult,
  config: AppConfig,
  runId: string,
  runDir: string,
  startedAt: Date
): AssembledReport {
  const { finalCtx, mapper, modelRouter, budget, safetyEvents, usageTracker } = pipelineResult;
  const provider = modelRouter.getExplorer();
  const status = statusFor(finalCtx.state);
  const usageSummary = usageTracker.summary();
  const criticProviderForCost = modelRouter.getCritic();
  const { estimatedCostUsd, disclosure: costDisclosure } = estimateRunCostUsd(provider.modelId, criticProviderForCost?.modelId, usageSummary);

  // Grouping runs on already-reviewed (post-disposition) findings, after
  // dedup and critic review, before final report assembly -- see README's
  // Cross-Finding Grouping section for why run-summary.json/benchmark.json/
  // phase2-metrics.json all deliberately stay on the RAW findings array
  // (never grouped) while report.json/report.md and the new grouping.json
  // are the only artifacts that reflect it.
  const grouping = groupFindings(finalCtx.findings, { enabled: config.grouping.enabled });

  const finishedAt = new Date();
  const applicationMap = mapper.toJSON();
  const pagesDiscovered = new Set([
    ...finalCtx.visitedPages,
    ...finalCtx.frontier.map((url) => normalizePathname(url)),
  ]).size;
  const interactiveControlsDiscovered = applicationMap.pages.reduce((sum, page) => sum + page.controls.length, 0);
  const heuristicsApplicable = finalCtx.offeredHeuristicKeys.size;
  const heuristicCoverage = computeHeuristicCoverage(finalCtx.heuristicsExecuted, heuristicsApplicable);

  const coverage = {
    pagesDiscovered,
    pagesVisited: finalCtx.pagesVisited,
    interactiveControlsDiscovered,
    heuristicsApplicable,
    heuristicsExecuted: finalCtx.heuristicsExecuted,
    heuristicCoverage,
  };
  const budgetSnapshot = budget.snapshot();

  const summary: RunSummary = {
    runId,
    project: config.project.name,
    target: config.target.url,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status,
    ...(finalCtx.stopReason ? { stopReason: finalCtx.stopReason } : {}),
    provider: provider.name,
    actionsPerformed: budget.actionsPerformed,
    modelCalls: budget.modelCalls,
    suspectedFindings: finalCtx.findings.length,
    validatedFindings: finalCtx.findings.filter((f) => f.status === "validated").length,
    rejectedFindings: finalCtx.findings.filter((f) => f.status === "rejected").length,
    needsHuman: finalCtx.findings.filter((f) => f.status === "needs_human").length,
    reportDispositionBreakdown: reportDispositionBreakdown(finalCtx.findings),
    coverage,
    budget: budgetSnapshot,
    usage: { explorer: usageSummary.explorer, critic: usageSummary.critic, estimatedCostUsd, costDisclosure },
  };
  writeRunSummary(runDir, summary);

  const groundTruthDefects =
    config.target.environment === "local-fixture" ? loadGroundTruth(resolve("fixture", "ground-truth.json")).defects : undefined;
  const benchmark = groundTruthDefects
    ? matchFindings(
        finalCtx.findings.filter((f) => f.status === "validated"),
        groundTruthDefects
      )
    : undefined;
  if (benchmark) {
    writeFileSync(join(runDir, "benchmark.json"), JSON.stringify(benchmark, null, 2), "utf-8");
  }

  // Detection asks "did AutoQA find it?" (status === "validated", Phase-1
  // semantics / Condition A); final-report asks "would a human actually see
  // it reported?" (reportDisposition === "report", Condition B). Same
  // matchFindings() matcher for both -- see reporting/phase2-metrics.ts.
  const phase2 =
    groundTruthDefects && config.models.critic.enabled
      ? computePhase2Metrics(
          benchmark as NonNullable<typeof benchmark>,
          matchFindings(
            finalCtx.findings.filter((f) => f.reportDisposition === "report"),
            groundTruthDefects
          )
        )
      : undefined;
  if (phase2) {
    writeFileSync(join(runDir, "phase2-metrics.json"), JSON.stringify(phase2, null, 2), "utf-8");
  }

  // Grouping's OWN effect, isolated from the critic's: the same matcher,
  // run against one representative per group plus every ungrouped finding
  // (canonical/grouped, reportDisposition==="report" only) -- never
  // blended into benchmark.json or phase2-metrics.json.
  const groupingBenchmark =
    groundTruthDefects && config.grouping.enabled
      ? matchFindings(
          canonicalFindingsOnly(finalCtx.findings, grouping).filter((f) => f.reportDisposition === "report"),
          groundTruthDefects
        )
      : undefined;
  if (groupingBenchmark) {
    writeFileSync(
      join(runDir, "grouping.json"),
      JSON.stringify({ ...grouping, benchmark: groupingBenchmark }, null, 2),
      "utf-8"
    );
  } else if (config.grouping.enabled) {
    writeFileSync(join(runDir, "grouping.json"), JSON.stringify(grouping, null, 2), "utf-8");
  }

  const report: QaReport = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status,
    ...(finalCtx.stopReason ? { stopReason: finalCtx.stopReason } : {}),
    target: { url: config.target.url, environment: config.target.environment },
    provider: { name: provider.name },
    applicationMap,
    coverage,
    findings: annotateWithGroupIds(finalCtx.findings, grouping),
    groups: grouping.groups,
    oracleBreakdown: buildOracleBreakdown(finalCtx.findings),
    reportDispositionBreakdown: reportDispositionBreakdown(finalCtx.findings),
    budget: budgetSnapshot,
    tracePolicy: TRACE_POLICY_STATEMENT,
    ...(benchmark ? { benchmark } : {}),
    ...(phase2 ? { phase2 } : {}),
    safetyEventCount: safetyEvents.length,
    ...(status === "failed" ? { errorClassification: finalCtx.stopReason } : {}),
    usage: summary.usage,
  };
  writeReportJson(runDir, report);
  writeReportMarkdown(runDir, buildReportMarkdown(report));

  return { summary, report };
}
