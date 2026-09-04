import "dotenv/config";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BrowserLaunchError, BrowserManager } from "./browser/browser.js";
import { BudgetTracker } from "./budget.js";
import { ConfigError, loadConfig, resolveHeadless, type AppConfig } from "./config.js";
import { ensureDir } from "./evidence.js";
import { createLogger, type Logger } from "./logger.js";
import { PageMapper } from "./mapping/mapper.js";
import { AnthropicModelProvider, MockModelProvider } from "./models/provider-implementation.js";
import type { ModelProvider } from "./models/provider.js";
import { buildOracleRegistry } from "./oracles.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createRunContext } from "./orchestrator/run-context.js";
import { allHeuristics } from "./qa/heuristics.js";
import { generateRunId, writeRunSummary, type RunSummary } from "./report.js";
import { startFixtureServer, type FixtureServer } from "../fixture/server.js";

function parseArgs(argv: string[]): { configPath: string } {
  const flagIndex = argv.indexOf("--config");
  const raw = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  return { configPath: resolve(raw ?? "qa.config.yaml") };
}

function selectProvider(config: AppConfig, logger: Logger): ModelProvider {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  const wantsAnthropic = config.models.provider === "anthropic" || (config.models.provider === "auto" && apiKey);

  if (wantsAnthropic) {
    if (!apiKey) {
      throw new ConfigError(
        'AutoQA configuration error\n\nmodels.provider is "anthropic" but ANTHROPIC_API_KEY is not set.'
      );
    }
    const model = config.models.model as string; // schema requires this when provider is "anthropic"
    logger.info({ provider: "anthropic", model }, "Using AnthropicModelProvider");
    return new AnthropicModelProvider(apiKey, logger, model);
  }

  logger.info({ provider: "mock" }, "Using deterministic MockModelProvider");
  return new MockModelProvider();
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

  let provider: ModelProvider;
  try {
    provider = selectProvider(config, logger);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  console.log(
    `AI provider: ${provider.name}${
      provider.name === "mock" ? " (no live model credentials found; using deterministic mock)" : ""
    }`
  );

  const browserManager = new BrowserManager(config, logger, headless);
  const budget = new BudgetTracker({
    maxActions: config.agent.maxActions,
    maxModelCalls: config.agent.maxModelCalls,
    maxPages: config.agent.maxPages,
    maxFindings: config.agent.maxFindings,
    maxDurationMs: config.agent.maxDurationMs,
  });
  const mapper = new PageMapper();
  const oracles = buildOracleRegistry(config);
  const heuristics = allHeuristics(config);

  let fixtureServer: FixtureServer | null = null;

  try {
    if (config.target.environment === "local-fixture") {
      const port = Number(new URL(config.target.url).port || "80");
      fixtureServer = await startFixtureServer(port);
      logger.info({ port }, "Local fixture server started");
      console.log("✓ Local fixture server started");
    }

    try {
      await browserManager.launch();
    } catch (error) {
      if (error instanceof BrowserLaunchError) {
        console.error(error.message);
        logger.error({ error: error.message }, "Browser launch failed");
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    console.log("✓ Chromium started\n");

    const orchestrator = new Orchestrator({
      browserManager,
      config,
      provider,
      logger,
      oracles,
      heuristics,
      budget,
      mapper,
      runDir,
      onProgress: (message) => console.log(message),
    });

    const initialCtx = createRunContext(runId, startedAt, config.target.url);
    const finalCtx = await orchestrator.run(initialCtx);

    await orchestrator.closeSession();

    if (finalCtx.state === "FAILED") {
      console.error(`\nRun FAILED: ${finalCtx.stopReason ?? "unknown error"}`);
      logger.error({ stopReason: finalCtx.stopReason }, "Run failed");
    }

    const mapPath = join(runDir, "application-map.json");
    writeFileSync(mapPath, JSON.stringify(mapper.toJSON(), null, 2), "utf-8");

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
  } finally {
    await browserManager.close();
    if (fixtureServer) {
      await fixtureServer.close();
      logger.info({}, "Local fixture server stopped");
    }
  }
}

main().catch((error: unknown) => {
  console.error("AutoQA encountered an unexpected error:");
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
