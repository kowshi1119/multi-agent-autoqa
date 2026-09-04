import "dotenv/config";
import { join, resolve } from "node:path";
import { BrowserLaunchError } from "./browser/browser.js";
import { ConfigError, loadConfig, resolveHeadless, type AppConfig } from "./config.js";
import { ensureDir } from "./evidence.js";
import { createLogger } from "./logger.js";
import { generateRunId, writeRunSummary, type RunSummary } from "./report.js";
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

  const { finalCtx, provider, budget } = result;

  if (finalCtx.state === "FAILED") {
    console.error(`\nRun FAILED: ${finalCtx.stopReason ?? "unknown error"}`);
    logger.error({ stopReason: finalCtx.stopReason }, "Run failed");
  }

  const finishedAt = new Date();
  const summary: RunSummary = {
    runId,
    project: config.project.name,
    target: config.target.url,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status: "completed",
    provider: provider.name,
    actionsPerformed: budget.actionsPerformed,
    modelCalls: budget.modelCalls,
    suspectedFindings: finalCtx.findings.length,
    validatedFindings: finalCtx.findings.filter((f) => f.status === "validated").length,
    rejectedFindings: finalCtx.findings.filter((f) => f.status === "rejected").length,
    needsHuman: finalCtx.findings.filter((f) => f.status === "needs_human").length,
    tokenUsage: null,
  };
  writeRunSummary(runDir, summary);
  logger.info({ summary, stopReason: finalCtx.stopReason }, "Run complete");

  console.log("\n=================================================");
  console.log("AutoQA Phase-1 Run Complete");
  console.log("=================================================\n");
  console.log(`Run ID:\n${summary.runId}\n`);
  console.log(`Target:\n${summary.target}\n`);
  console.log(`Provider:\n${summary.provider}\n`);
  console.log(`Pages visited:\n${finalCtx.pagesVisited}\n`);
  console.log(`Heuristics executed:\n${finalCtx.heuristicsExecuted}\n`);
  console.log(`Actions:\n${summary.actionsPerformed}\n`);
  console.log(`Model calls:\n${summary.modelCalls}\n`);
  console.log(`Findings suspected:\n${summary.suspectedFindings}\n`);
  console.log(`Validated:\n${summary.validatedFindings}\n`);
  console.log(`Rejected:\n${summary.rejectedFindings}\n`);
  console.log(`Needs human:\n${summary.needsHuman}\n`);
  console.log(`Stop reason:\n${finalCtx.stopReason ?? "(none recorded)"}\n`);
  console.log(`Artifacts:\nruns/${summary.runId}`);
  console.log("=================================================");
}

main().catch((error: unknown) => {
  console.error("AutoQA encountered an unexpected error:");
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
