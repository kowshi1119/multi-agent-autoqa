import "dotenv/config";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BrowserLaunchError } from "./browser/browser.js";
import { ConfigError, loadConfig, resolveHeadless, type AppConfig } from "./config.js";
import { ensureDir } from "./evidence.js";
import { createLogger } from "./logger.js";
import { normalizePathname } from "./mapping/state-signature.js";
import { generateRunId, writeRunSummary, type RunSummary } from "./report.js";
import { loadGroundTruth, matchFindings } from "./reporting/benchmark.js";
import { computeHeuristicCoverage } from "./reporting/coverage.js";
import { computePhase2Metrics } from "./reporting/phase2-metrics.js";
import {
  buildOracleBreakdown,
  buildReportMarkdown,
  writeReportJson,
  writeReportMarkdown,
  TRACE_POLICY_STATEMENT,
  type QaReport,
} from "./reporting/qa-report.js";
import { runPipeline } from "./run-pipeline.js";
import type { Finding } from "./types.js";

function reportDispositionBreakdown(findings: Finding[]): { report: number; suppress: number; needs_human: number } {
  const breakdown = { report: 0, suppress: 0, needs_human: 0 };
  for (const finding of findings) breakdown[finding.reportDisposition] += 1;
  return breakdown;
}

function parseArgs(argv: string[]): { configPath: string } {
  const flagIndex = argv.indexOf("--config");
  const raw = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  return { configPath: resolve(raw ?? "qa.config.yaml") };
}

async function main(): Promise<void> {
  const { configPath } = parseArgs(process.argv.slice(2));

  let config: AppConfig;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const startedAt = new Date();
  const runId = generateRunId(startedAt);
  const runDir = resolve("runs", runId);
  ensureDir(runDir);

  const logger = createLogger(join(runDir, "run.log"));
  const { headless, reason: headlessReason } = resolveHeadless(config);

  console.log("AutoQA Phase 1\n");
  console.log(`Run: ${runId}`);
  console.log(`Target: ${config.target.url}`);
  console.log(`Safe mode: ${config.safety.safeMode ? "ON" : "OFF"}`);
  console.log(`Headless: ${headless ? "ON" : "OFF"} — ${headlessReason}\n`);

  logger.info({ runId, headless, headlessReason, target: config.target.url }, "Run started");
  console.log("✓ Configuration loaded");

  let result;
  try {
    result = await runPipeline({
      config,
      runId,
      runDir,
      logger,
      headless,
      onProgress: (message) => console.log(message),
    });
  } catch (error) {
    if (error instanceof ConfigError || error instanceof BrowserLaunchError) {
      console.error(error.message);
      logger.error({ error: error.message }, error.name);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const { finalCtx, modelRouter, budget, mapper, safetyEvents } = result;
  const provider = modelRouter.getExplorer();
  const failed = finalCtx.state === "FAILED";

  if (failed) {
    console.error(`\nRun FAILED: ${finalCtx.stopReason ?? "unknown error"}`);
    logger.error({ stopReason: finalCtx.stopReason }, "Run failed");
  }

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
    status: failed ? "failed" : "completed",
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
    tokenUsage: null,
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

  const report: QaReport = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status: failed ? "failed" : "completed",
    ...(finalCtx.stopReason ? { stopReason: finalCtx.stopReason } : {}),
    target: { url: config.target.url, environment: config.target.environment },
    provider: { name: provider.name },
    applicationMap,
    coverage,
    findings: finalCtx.findings,
    oracleBreakdown: buildOracleBreakdown(finalCtx.findings),
    reportDispositionBreakdown: reportDispositionBreakdown(finalCtx.findings),
    budget: budgetSnapshot,
    tracePolicy: TRACE_POLICY_STATEMENT,
    ...(benchmark ? { benchmark } : {}),
    ...(phase2 ? { phase2 } : {}),
    safetyEventCount: safetyEvents.length,
    ...(failed ? { errorClassification: finalCtx.stopReason } : {}),
  };
  writeReportJson(runDir, report);
  writeReportMarkdown(runDir, buildReportMarkdown(report));

  logger.info({ summary, stopReason: finalCtx.stopReason }, "Run complete");

  console.log("\n=================================================");
  console.log("AutoQA Phase-1 Run Complete");
  console.log("=================================================\n");
  console.log(`Run ID:\n${summary.runId}\n`);
  console.log(`Target:\n${summary.target}\n`);
  console.log(`Provider:\n${summary.provider}\n`);
  console.log(`Pages visited:\n${coverage.pagesVisited} (of ${coverage.pagesDiscovered} discovered)\n`);
  console.log(`Heuristics executed:\n${coverage.heuristicsExecuted} (coverage: ${(coverage.heuristicCoverage * 100).toFixed(1)}%)\n`);
  console.log(`Actions:\n${summary.actionsPerformed}\n`);
  console.log(`Model calls:\n${summary.modelCalls}\n`);
  console.log(`Findings suspected:\n${summary.suspectedFindings}\n`);
  console.log(`Validated:\n${summary.validatedFindings}\n`);
  console.log(`Rejected:\n${summary.rejectedFindings}\n`);
  console.log(`Needs human:\n${summary.needsHuman}\n`);
  console.log(`Safety events:\n${safetyEvents.length}\n`);
  if (benchmark) {
    console.log(
      `Benchmark (detection):\nprecision ${benchmark.precision.toFixed(2)} / recall ${benchmark.recall.toFixed(2)} / F1 ${benchmark.f1.toFixed(2)}\n`
    );
  }
  if (phase2) {
    console.log(
      `Benchmark (final report):\nprecision ${phase2.finalReport.precision.toFixed(2)} / recall ${phase2.finalReport.recall.toFixed(2)} / F1 ${phase2.finalReport.f1.toFixed(2)}\n`
    );
    console.log(
      `Critic false-positive reduction:\n${phase2.falsePositivesSuppressed} suppressed (${(phase2.falsePositiveReductionRate * 100).toFixed(1)}%), recall loss ${(phase2.recallLoss * 100).toFixed(1)}%\n`
    );
  }
  console.log(`Stop reason:\n${finalCtx.stopReason ?? "(none recorded)"}\n`);
  console.log(`Artifacts:\nruns/${summary.runId}`);
  console.log("=================================================");
}

main().catch((error: unknown) => {
  console.error("AutoQA encountered an unexpected error:");
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
