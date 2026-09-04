import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserManager } from "./browser/browser.js";
import { BudgetTracker } from "./budget.js";
import { ConfigError, type AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { PageMapper } from "./mapping/mapper.js";
import { AnthropicModelProvider, MockModelProvider } from "./models/provider-implementation.js";
import type { ModelProvider } from "./models/provider.js";
import { buildOracleRegistry } from "./oracles.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createRunContext, type RunContext } from "./orchestrator/run-context.js";
import { allHeuristics } from "./qa/heuristics.js";
import { startFixtureServer, type FixtureServer } from "../fixture/server.js";

/** Shared by both `qa` and `benchmark` entry points so the pipeline exists in exactly one place. */
export function selectProvider(config: AppConfig, logger: Logger): ModelProvider {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  const wantsAnthropic = config.models.provider === "anthropic" || (config.models.provider === "auto" && Boolean(apiKey));

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

export type PipelineResult = {
  finalCtx: RunContext;
  mapper: PageMapper;
  provider: ModelProvider;
  budget: BudgetTracker;
};

export type PipelineOptions = {
  config: AppConfig;
  runId: string;
  runDir: string;
  logger: Logger;
  headless: boolean;
  onProgress?: (message: string) => void;
};

/**
 * Launches the fixture (if configured), the browser, and runs the
 * Orchestrator once. Writes application-map.json. Both `npm run qa` and
 * `npm run benchmark` build on this exact same pipeline — the only
 * difference is what each does with the result afterward.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { config, runId, runDir, logger, headless, onProgress } = options;

  const provider = selectProvider(config, logger);
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
      onProgress?.("✓ Local fixture server started");
    }

    await browserManager.launch();
    onProgress?.("✓ Chromium started\n");

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
      ...(onProgress ? { onProgress } : {}),
    });

    const initialCtx = createRunContext(runId, new Date(), config.target.url);
    const finalCtx = await orchestrator.run(initialCtx);
    await orchestrator.closeSession();

    writeFileSync(join(runDir, "application-map.json"), JSON.stringify(mapper.toJSON(), null, 2), "utf-8");

    return { finalCtx, mapper, provider, budget };
  } finally {
    await browserManager.close();
    if (fixtureServer) {
      await fixtureServer.close();
      logger.info({}, "Local fixture server stopped");
    }
  }
}
