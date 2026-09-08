import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserManager } from "./browser/browser.js";
import { BudgetTracker } from "./budget.js";
import { ConfigError, type AppConfig } from "./config.js";
import { AnthropicCriticProvider } from "./critic/anthropic-critic-provider.js";
import { ExplabsCriticProvider } from "./critic/explabs-critic-provider.js";
import { MockCriticProvider } from "./critic/mock-critic-provider.js";
import type { Logger } from "./logger.js";
import { PageMapper } from "./mapping/mapper.js";
import type { CriticProvider } from "./models/critic-provider.js";
import { ModelRouter } from "./models/model-router.js";
import { resolveProviderCredential } from "./models/provider-credentials.js";
import { AnthropicModelProvider, ExplabsModelProvider, MockModelProvider } from "./models/provider-implementation.js";
import type { ExplorerProvider } from "./models/provider.js";
import { buildOracleRegistry } from "./oracles.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createRunContext, type RunContext } from "./orchestrator/run-context.js";
import { allHeuristics } from "./qa/heuristics.js";
import { loadRequirements } from "./requirements.js";
import type { RequirementRule, SafetyEvent } from "./types.js";
import { startFixtureServer, type FixtureServer } from "../fixture/server.js";

const UNIMPLEMENTED_PROVIDERS = new Set(["openai", "ollama"]);

/** Shared by both `qa` and `benchmark` entry points so the pipeline exists in exactly one place. */
export function selectProvider(config: AppConfig, logger: Logger): ExplorerProvider {
  const apiKey = resolveProviderCredential("anthropic", "explorer");
  const wantsAnthropic =
    config.models.explorer.provider === "anthropic" || (config.models.explorer.provider === "auto" && Boolean(apiKey));

  if (UNIMPLEMENTED_PROVIDERS.has(config.models.explorer.provider)) {
    throw new ConfigError(
      `AutoQA configuration error\n\nmodels.explorer.provider "${config.models.explorer.provider}" is not implemented in this build; supported: mock, anthropic — see README Known Limitations.`
    );
  }

  if (wantsAnthropic) {
    if (!apiKey) {
      throw new ConfigError(
        'AutoQA configuration error\n\nmodels.explorer.provider is "anthropic" but ANTHROPIC_API_KEY is not set.'
      );
    }
    const model = config.models.explorer.model as string; // schema requires this for a non-mock/auto provider
    logger.info({ provider: "anthropic", model }, "Using AnthropicModelProvider");
    return new AnthropicModelProvider(apiKey, logger, model);
  }

  if (config.models.explorer.provider === "explabs") {
    const explabsKey = resolveProviderCredential("explabs", "explorer");
    if (!explabsKey) {
      throw new ConfigError('MODEL_CONFIGURATION_ERROR: models.explorer.provider is "explabs" but EXPLABS_API_KEY is not set.');
    }
    const model = config.models.explorer.model as string;
    logger.info({ provider: "explabs", model, credentialAvailable: true }, "Using ExplabsModelProvider");
    return new ExplabsModelProvider(explabsKey, logger, model);
  }

  logger.info({ provider: "mock" }, "Using deterministic MockModelProvider");
  return new MockModelProvider();
}

/**
 * Mirrors selectProvider()'s exact idiom for the critic role. Returns null
 * when the critic is disabled by config — not a no-op stub (see
 * ModelRouter's doc comment for why nullable is the deliberate choice).
 */
export function selectCriticProvider(config: AppConfig, logger: Logger): CriticProvider | null {
  if (!config.models.critic.enabled) {
    logger.info({}, "Critic disabled by config (models.critic.enabled=false)");
    return null;
  }

  if (UNIMPLEMENTED_PROVIDERS.has(config.models.critic.provider)) {
    throw new ConfigError(
      `AutoQA configuration error\n\nmodels.critic.provider "${config.models.critic.provider}" is not implemented in this build; supported: mock, anthropic — see README Known Limitations.`
    );
  }

  if (config.models.critic.provider === "anthropic") {
    const apiKey = resolveProviderCredential("anthropic", "critic");
    if (!apiKey) {
      throw new ConfigError(
        'AutoQA configuration error\n\nmodels.critic.provider is "anthropic" but ANTHROPIC_API_KEY is not set.'
      );
    }
    const model = config.models.critic.model as string; // schema requires this for a non-mock provider
    logger.info({ provider: "anthropic", model }, "Using AnthropicCriticProvider");
    return new AnthropicCriticProvider(apiKey, logger, model);
  }

  if (config.models.critic.provider === "explabs") {
    const apiKey = resolveProviderCredential("explabs", "critic");
    if (!apiKey) {
      throw new ConfigError('MODEL_CONFIGURATION_ERROR: models.critic.provider is "explabs" but EXPLABS_API_KEY is not set.');
    }
    const model = config.models.critic.model as string;
    logger.info({ provider: "explabs", model, credentialAvailable: true }, "Using ExplabsCriticProvider");
    return new ExplabsCriticProvider(apiKey, logger, model);
  }

  logger.info({ provider: "mock" }, "Using deterministic MockCriticProvider");
  return new MockCriticProvider();
}

export type PipelineResult = {
  finalCtx: RunContext;
  mapper: PageMapper;
  modelRouter: ModelRouter;
  budget: BudgetTracker;
  safetyEvents: SafetyEvent[];
  requirements: RequirementRule[];
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

  const modelRouter = new ModelRouter(selectProvider(config, logger), selectCriticProvider(config, logger));
  const browserManager = new BrowserManager(config, logger, headless);
  const budget = new BudgetTracker({
    maxActions: config.agent.maxActions,
    maxModelCalls: config.agent.maxModelCalls,
    maxPages: config.agent.maxPages,
    maxFindings: config.agent.maxFindings,
    maxDurationMs: config.agent.maxDurationMs,
    maxCriticCalls: config.agent.maxCriticCalls,
  });
  const mapper = new PageMapper();
  const oracles = buildOracleRegistry(config);
  const heuristics = allHeuristics(config);
  const requirements = config.requirements.enabled ? loadRequirements(config.requirements.path) : [];

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
      modelRouter,
      logger,
      oracles,
      heuristics,
      budget,
      mapper,
      runDir,
      requirements,
      ...(onProgress ? { onProgress } : {}),
    });

    const initialCtx = createRunContext(runId, new Date(), config.target.url);
    const finalCtx = await orchestrator.run(initialCtx);
    const safetyEvents = orchestrator.getSafetyEvents();
    await orchestrator.closeSession();

    writeFileSync(join(runDir, "application-map.json"), JSON.stringify(mapper.toJSON(), null, 2), "utf-8");

    return { finalCtx, mapper, modelRouter, budget, safetyEvents, requirements };
  } finally {
    await browserManager.close();
    if (fixtureServer) {
      await fixtureServer.close();
      logger.info({}, "Local fixture server stopped");
    }
  }
}
