import type { WorkflowManifest } from "./pilot/workflow-manifest.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionBootstrap, TransientCredentials } from "./auth/session-bootstrap.js";
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
import { assertLiveModeAuthorized } from "./models/live-gate.js";
import { AnthropicModelProvider, ExplabsModelProvider, MockModelProvider } from "./models/provider-implementation.js";
import { GeminiModelProvider } from "./models/gemini-provider.js";
import { OllamaModelProvider } from "./models/ollama-provider.js";
import type { ExplorerProvider } from "./models/provider.js";
import { buildOracleRegistry } from "./oracles.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createRunContext, type RunContext } from "./orchestrator/run-context.js";
import { parseProfile, type ProjectProfile } from "./profiles/schema.js";
import { allHeuristics } from "./qa/heuristics.js";
import { loadRequirements } from "./requirements.js";
import type { RunProgressEvent } from "./progress.js";
import type { RunSession } from "./checks/request-scope.js";
import { UsageTracker } from "./models/usage-tracker.js";
import { ActionPolicy } from "./safety/action-policy.js";
import type { RequirementRule, SafetyEvent } from "./types.js";
import { startFixtureServer, type FixtureServer } from "../fixture/server.js";

const UNIMPLEMENTED_PROVIDERS = new Set(["openai"]);

/**
 * Shared by both `qa` and `benchmark` entry points so the pipeline exists
 * in exactly one place.
 *
 * `usageTracker`, when supplied, is passed into a real provider's
 * constructor so it can record every actual HTTP attempt (first + any
 * repair) at its own request boundary (Phase 4 continuation accounting
 * fix) -- never passed to MockModelProvider, which makes no real request
 * to record.
 */
export function selectProvider(config: AppConfig, logger: Logger, usageTracker?: UsageTracker, budget?: BudgetTracker): ExplorerProvider {
  if (config.models.explorer.provider === "gemini") {
    const key = resolveProviderCredential("gemini", "explorer");
    const model = config.models.explorer.model;
    if (!key?.trim() || !model?.trim()) {
      throw new ConfigError("MODEL_CONFIGURATION_ERROR: Gemini Explorer requires GEMINI_API_KEY and models.explorer.model.");
    }
    const provider = new GeminiModelProvider(key, logger, model, usageTracker, budget, config.models.providerTimeoutMs);
    logger.info({ provider: "gemini", model, credentialAvailable: true }, "Using GeminiModelProvider");
    return provider;
  }
  const apiKey = resolveProviderCredential("anthropic", "explorer");
  const wantsAnthropic =
    config.models.explorer.provider === "anthropic" || (config.models.explorer.provider === "auto" && Boolean(apiKey));

  if (UNIMPLEMENTED_PROVIDERS.has(config.models.explorer.provider)) {
    throw new ConfigError(
      `AutoQA configuration error\n\nmodels.explorer.provider "${config.models.explorer.provider}" is not implemented in this build; supported: mock, anthropic, explabs, gemini, ollama — see README Known Limitations.`
    );
  }

  if (config.models.explorer.provider === "ollama") {
    // No API key: resolveProviderCredential() deliberately has no "ollama"
    // branch (see provider-credentials.ts). Base URL is local-adapter
    // configuration, not a secret, so it's read directly here rather than
    // forced through that (provider, role) -> secret shape.
    const baseUrl = process.env["OLLAMA_BASE_URL"]?.trim() || "http://127.0.0.1:11434";
    const model = config.models.explorer.model as string; // schema requires this for a non-mock/auto provider
    const provider = new OllamaModelProvider(baseUrl, model, logger, usageTracker, budget, config.models.providerTimeoutMs);
    logger.info({ provider: "ollama", model, baseUrl }, "Using OllamaModelProvider");
    return provider;
  }

  if (wantsAnthropic) {
    if (!apiKey) {
      throw new ConfigError(
        'AutoQA configuration error\n\nmodels.explorer.provider is "anthropic" but ANTHROPIC_API_KEY is not set.'
      );
    }
    const model = config.models.explorer.model as string; // schema requires this for a non-mock/auto provider
    logger.info({ provider: "anthropic", model }, "Using AnthropicModelProvider");
    return new AnthropicModelProvider(apiKey, logger, model, usageTracker, budget);
  }

  if (config.models.explorer.provider === "explabs") {
    const explabsKey = resolveProviderCredential("explabs", "explorer");
    if (!explabsKey) {
      throw new ConfigError('MODEL_CONFIGURATION_ERROR: models.explorer.provider is "explabs" but EXPLABS_API_KEY is not set.');
    }
    const model = config.models.explorer.model as string;
    logger.info({ provider: "explabs", model, credentialAvailable: true }, "Using ExplabsModelProvider");
    return new ExplabsModelProvider(explabsKey, logger, model, usageTracker, budget);
  }

  logger.info({ provider: "mock" }, "Using deterministic MockModelProvider");
  return new MockModelProvider();
}

/**
 * Mirrors selectProvider()'s exact idiom for the critic role. Returns null
 * when the critic is disabled by config — not a no-op stub (see
 * ModelRouter's doc comment for why nullable is the deliberate choice).
 */
export function selectCriticProvider(config: AppConfig, logger: Logger, usageTracker?: UsageTracker, budget?: BudgetTracker): CriticProvider | null {
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
    return new AnthropicCriticProvider(apiKey, logger, model, usageTracker, budget);
  }

  if (config.models.critic.provider === "explabs") {
    const apiKey = resolveProviderCredential("explabs", "critic");
    if (!apiKey) {
      throw new ConfigError('MODEL_CONFIGURATION_ERROR: models.critic.provider is "explabs" but EXPLABS_API_KEY is not set.');
    }
    const model = config.models.critic.model as string;
    logger.info({ provider: "explabs", model, credentialAvailable: true }, "Using ExplabsCriticProvider");
    return new ExplabsCriticProvider(apiKey, logger, model, usageTracker, budget);
  }

  logger.info({ provider: "mock" }, "Using deterministic MockCriticProvider");
  return new MockCriticProvider();
}

/**
 * Real-target CLI protection (Phase 4 continuation): a direct
 * `npm run qa -- --config <real-target>.yaml` run (never going through
 * RunManager, the only place that previously constructed an ActionPolicy
 * at all) got ZERO action-policy enforcement -- confirmed as a real gap.
 * When the caller doesn't supply a policy and the target isn't the local
 * fixture, build a conservative fallback from the AppConfig alone: every
 * scope field defaults to empty, so anything requiring an explicit
 * allowlist entry (a form submit, an API resource request, a navigation
 * link, a pagination control) is denied by construction -- the correct
 * conservative default for a real target with no declared profile scope.
 * Never applies to a "local-fixture" environment, so existing fixture
 * behavior is completely unaffected.
 */
function buildFallbackActionPolicy(config: AppConfig): ActionPolicy {
  const profile = parseProfile({
    schemaVersion: 1,
    id: "__cli-fallback__",
    name: "CLI direct run (no project profile supplied) -- conservative default-deny real-target policy",
    target: { url: config.target.url, environmentKind: "self-hosted-real-app" },
    navigation: { allowedOrigins: config.safety.allowedOrigins, allowedPathPrefixes: [] },
    resources: { allowedApiOrigins: [], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: [] },
    auth: { mode: "none" },
    provider: config.models,
    limits: {
      maxActions: config.agent.maxActions,
      maxModelCalls: config.agent.maxModelCalls,
      maxPages: config.agent.maxPages,
      maxFindings: config.agent.maxFindings,
      maxDurationMs: config.agent.maxDurationMs,
      maxCriticCalls: config.agent.maxCriticCalls,
    },
  });
  return new ActionPolicy(profile);
}

export type PipelineResult = {
  finalCtx: RunContext;
  mapper: PageMapper;
  modelRouter: ModelRouter;
  budget: BudgetTracker;
  safetyEvents: SafetyEvent[];
  requirements: RequirementRule[];
  usageTracker: UsageTracker;
};

export type PipelineOptions = {
  config: AppConfig;
  workflowManifest?: WorkflowManifest;
  authenticationOnly?: boolean;
  runId: string;
  runDir: string;
  logger: Logger;
  headless: boolean;
  onProgress?: (event: RunProgressEvent) => void;
  /** Real-target action safety (Phase 4 Milestone A2) -- absent for a legacy direct-YAML CLI run, preserving today's behavior exactly. */
  actionPolicy?: ActionPolicy;
  /** Session bootstrap / authentication (Phase 4 Milestone A3) -- absent for a no-auth profile/legacy direct-YAML run. */
  sessionAuth?: { sessionBootstrap: SessionBootstrap; profile: ProjectProfile; credentials?: TransientCredentials };
  /** UI-driven stop (Phase 4 Milestone B) -- absent for a CLI run. */
  abortSignal?: AbortSignal;
  /**
   * Live-execution gating (Phase 4 continuation) -- when supplied, asserts
   * assertLiveModeAuthorized(config, argv) immediately after providers are
   * resolved, before the browser (or any provider request) launches.
   * Passed by every direct-CLI entry point (`qa`, `benchmark`, Phase 3
   * capture); deliberately left absent for RunManager's UI-driven runs,
   * which already enforce their own, separate mode/confirmedLimits gate
   * and have no CLI argv to check.
   */
  requireLiveAuthorization?: { argv: readonly string[] };
  /**
   * Called once exploration/workflows finish, while the run's browser
   * context (and local fixture server) are still open -- the only window in
   * which the run's own authenticated session can be used. Skipped for
   * authentication-only, failed or cancelled runs. `session` is present for
   * form-login profiles (authenticated:false if login did not succeed).
   */
  onSessionReady?: (ready: { finalCtx: RunContext; origin: string; session?: RunSession }) => Promise<void>;
};

/**
 * Launches the fixture (if configured), the browser, and runs the
 * Orchestrator once. Writes application-map.json. Both `npm run qa` and
 * `npm run benchmark` build on this exact same pipeline — the only
 * difference is what each does with the result afterward.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { config, runId, runDir, logger, headless, onProgress, sessionAuth, abortSignal } = options;
  const actionPolicy = options.actionPolicy ?? (config.target.environment !== "local-fixture" ? buildFallbackActionPolicy(config) : undefined);

  if (options.requireLiveAuthorization) {
    assertLiveModeAuthorized(config, options.requireLiveAuthorization.argv);
  }

  // Constructed BEFORE selectProvider()/selectCriticProvider() (Phase 4
  // continuation accounting fix) so it can be threaded into each real
  // provider's constructor -- usage is now recorded at the provider's own
  // request boundary, not wrapped around the whole logical decision.
  const usageTracker = new UsageTracker();
  // §4 fix (2026-09-14 addendum): budget is now ALSO threaded into each
  // real provider's constructor (same reason as usageTracker above) --
  // moved ahead of selectProvider()/selectCriticProvider() so it exists
  // before those calls need it.
  const budget = new BudgetTracker({
    maxActions: config.agent.maxActions,
    maxModelCalls: config.agent.maxModelCalls,
    maxPages: config.agent.maxPages,
    maxFindings: config.agent.maxFindings,
    maxDurationMs: config.agent.maxDurationMs,
    maxCriticCalls: config.agent.maxCriticCalls,
  });
  const modelRouter = new ModelRouter(
    selectProvider(config, logger, usageTracker, budget),
    selectCriticProvider(config, logger, usageTracker, budget)
  );
  const browserManager = new BrowserManager(config, logger, headless, actionPolicy?.isDeclaredMode() ? budget : undefined);
  const mapper = new PageMapper();
  const oracles = buildOracleRegistry(config);
  const heuristics = allHeuristics(config);
  const requirements = config.requirements.enabled ? loadRequirements(config.requirements.path) : [];

  let fixtureServer: FixtureServer | null = null;

  const preRunProgress = (detail: string): void =>
    onProgress?.({
      phase: "checking-setup",
      detail,
      pagesVisited: 0,
      actionsPerformed: 0,
      remainingActions: config.agent.maxActions,
      remainingDurationMs: config.agent.maxDurationMs,
      reportableCount: 0,
      needsReviewCount: 0,
    });

  try {
    if (config.target.environment === "local-fixture") {
      // §Port isolation fix (2026-09-16): previously the literal port in
      // config.target.url was read and passed to startFixtureServer(port),
      // requiring every local-fixture test/config to hand-pick a port
      // distinct from every other one that might run concurrently -- a
      // registry of six hardcoded ports existed purely to dodge EADDRINUSE
      // collisions (see tests/helpers/ports.ts, now retired). Always
      // binding to port 0 (OS-assigned) and substituting the real bound
      // origin back into `config` in place -- before anything below reads
      // it -- makes every local-fixture run collision-free regardless of
      // whatever port its config/profile happens to declare; that literal
      // value is now inert placeholder text, never actually bound. `config`
      // is captured by reference (not copied) by BrowserManager above and
      // read lazily by everything downstream (including
      // createRunContext()'s call just below), so mutating it here, before
      // any of those reads actually happen, is sufficient -- no
      // construction-order changes needed elsewhere in this function.
      // Every other environment (self-hosted-real-app/owned-sandbox) never
      // enters this branch at all, so a real user's own configured port is
      // completely untouched.
      const declaredUrl = new URL(config.target.url);
      const declaredOrigin = declaredUrl.origin;
      fixtureServer = await startFixtureServer(0);
      declaredUrl.port = String(fixtureServer.port);
      const realOrigin = declaredUrl.origin;
      config.target.url = declaredUrl.toString();
      // A local-fixture config/profile declares exactly one origin (its own
      // fixture target); substitute it, preserving any other entry present.
      config.safety.allowedOrigins = config.safety.allowedOrigins.map((origin) => (origin === declaredOrigin ? realOrigin : origin));
      logger.info({ port: fixtureServer.port }, "Local fixture server started");
      preRunProgress("✓ Local fixture server started");
    }

    await browserManager.launch();
    preRunProgress("✓ Chromium started");

    const orchestrator = new Orchestrator({
      browserManager,
      workflowManifest: options.workflowManifest,
      authenticationOnly: options.authenticationOnly,
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
      ...(actionPolicy ? { actionPolicy } : {}),
      ...(sessionAuth ? { sessionAuth } : {}),
      ...(abortSignal ? { abortSignal } : {}),
    });

    const initialCtx = createRunContext(runId, new Date(), config.target.url);
    const finalCtx = await orchestrator.run(initialCtx);
    const safetyEvents = orchestrator.getSafetyEvents();
    const authObserver = orchestrator.getAuthObserver();
    if (authObserver && !options.authenticationOnly) {
      writeFileSync(join(runDir, "auth-mechanism.json"), JSON.stringify(authObserver.summary(), null, 2), "utf-8");
    }
    if (options.onSessionReady && !options.authenticationOnly && !abortSignal?.aborted && finalCtx.state !== "FAILED" && finalCtx.state !== "CANCELLED") {
      const context = orchestrator.getAuthenticatedContext();
      const session: RunSession | undefined = sessionAuth
        ? {
            authenticated: Boolean(context),
            ...(sessionAuth.profile.auth.loginUrl ? { loginPathname: new URL(sessionAuth.profile.auth.loginUrl).pathname } : {}),
            cookieHeaderFor: async (url: string) => {
              const cookies = context ? await context.cookies([url]) : [];
              return cookies.length ? cookies.map((c) => `${c.name}=${c.value}`).join("; ") : undefined;
            },
            authorizationFor: (url: string) => (context ? authObserver?.authorizationFor(url) : undefined),
            describeAuth: (url: string) => authObserver?.describe(url) ?? "no application API calls were observed",
            authSchemesFor: (url: string) => authObserver?.schemesFor(url) ?? [],
          }
        : undefined;
      await options.onSessionReady({ finalCtx, origin: new URL(config.target.url).origin, ...(session ? { session } : {}) });
    }
    await orchestrator.closeSession();

    writeFileSync(join(runDir, "application-map.json"), JSON.stringify(mapper.toJSON(), null, 2), "utf-8");

    return { finalCtx, mapper, modelRouter, budget, safetyEvents, requirements, usageTracker };
  } finally {
    await browserManager.close();
    if (fixtureServer) {
      await fixtureServer.close();
      logger.info({}, "Local fixture server stopped");
    }
  }
}
