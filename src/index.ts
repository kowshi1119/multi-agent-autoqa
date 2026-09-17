import "dotenv/config";
import { join, resolve } from "node:path";
import { BrowserLaunchError } from "./browser/browser.js";
import { ConfigError, loadConfig, resolveHeadless, type AppConfig } from "./config.js";
import { ensureDir } from "./evidence.js";
import { createLogger } from "./logger.js";
import { LiveModeNotAuthorizedError } from "./models/live-gate.js";
import { generateRunId } from "./report.js";
import { assembleReport } from "./reporting/assemble.js";
import { isMainModule } from "./main-module-guard.js";
import { runPipeline } from "./run-pipeline.js";

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
      onProgress: (event) => console.log(event.detail),
      requireLiveAuthorization: { argv: process.argv },
    });
  } catch (error) {
    if (error instanceof ConfigError || error instanceof BrowserLaunchError || error instanceof LiveModeNotAuthorizedError) {
      console.error(error.message);
      logger.error({ error: error.message }, error.name);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const failed = result.finalCtx.state === "FAILED";
  if (failed) {
    console.error(`\nRun FAILED: ${result.finalCtx.stopReason ?? "unknown error"}`);
    logger.error({ stopReason: result.finalCtx.stopReason }, "Run failed");
  }

  const { summary, report } = assembleReport(result, config, runId, runDir, startedAt);
  const coverage = summary.coverage;
  const benchmark = report.benchmark;
  const phase2 = report.phase2;
  const safetyEvents = result.safetyEvents;

  logger.info({ summary, stopReason: result.finalCtx.stopReason }, "Run complete");

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
  console.log(`Stop reason:\n${result.finalCtx.stopReason ?? "(none recorded)"}\n`);
  console.log(`Artifacts:\nruns/${summary.runId}`);
  console.log("=================================================");
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("AutoQA encountered an unexpected error:");
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
