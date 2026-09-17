import { loadWorkflowManifest, type WorkflowManifest } from "./pilot/workflow-manifest.js";
import { snapshotManifest } from "./pilot/workflow-runtime.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FormLoginBootstrap, NoAuthBootstrap, type TransientCredentials } from "./auth/session-bootstrap.js";
import { BrowserLaunchError } from "./browser/browser.js";
import { ConfigError } from "./config.js";
import { ensureDir } from "./evidence.js";
import { createLogger, type Logger } from "./logger.js";
import { estimateRunCostUsd } from "./models/pricing.js";
import { runPreflight, type PreflightCheck } from "./preflight/doctor.js";
import type { RunProgressEvent } from "./progress.js";
import type { ProjectProfile } from "./profiles/schema.js";
import type { ProfileStore } from "./profiles/store.js";
import { profileToAppConfig } from "./profiles/to-app-config.js";
import { credentialSecrets } from "./redact.js";
import { generateRunId, writeRunSummary, type RunSummary } from "./report.js";
import { assembleReport } from "./reporting/assemble.js";
import { runPipeline, type PipelineResult } from "./run-pipeline.js";
import { ActionPolicy } from "./safety/action-policy.js";

export class RunAlreadyActiveError extends Error {
  constructor() {
    super("A run is already active. Stop it before starting another.");
    this.name = "RunAlreadyActiveError";
  }
}

export class LiveModeNotConfirmedError extends Error {
  constructor() {
    super("Live mode requires confirmedLimits matching the profile's configured limits, echoed back before the run starts.");
    this.name = "LiveModeNotConfirmedError";
  }
}

/**
 * Confirmed Phase 4 continuation gap: the UI's own "Check setup" button
 * calling runPreflight() was purely advisory -- startRun() never actually
 * enforced it, so a run could be started by skipping that button
 * entirely, or after seeing a failure and clicking Start anyway. Thrown
 * only for a genuine "fail" check ("managed"/"skipped"/"pass" never
 * block); names the specific failing check so the caller can render it
 * clearly rather than a generic refusal.
 */
export class PreflightFailedError extends Error {
  constructor(public readonly failedChecks: PreflightCheck[]) {
    super(
      `Preflight failed: ${failedChecks.map((c) => `${c.name} (${c.detail})`).join("; ")}. Run "Check setup" in the UI (or \`npm run doctor -- --profile <id>\`) to see the full report.`
    );
    this.name = "PreflightFailedError";
  }
}

export type RunMode = "demo" | "live";

export type StartRunInput = {
  profileId: string;
  authenticationOnly?: boolean;
  workflowIds?: string[];
  mode: RunMode;
  credentials?: TransientCredentials;
  /**
   * Required, and must deep-equal the profile's own limits, when
   * mode==="live" -- the mechanism behind "no live call happens without
   * having shown provider/model/limits first" (see D1). Not a security
   * boundary by itself, just the one field whose presence is the enforced
   * precondition for a live run.
   */
  confirmedLimits?: ProjectProfile["limits"];
};

/**
 * `lastEvent` (Phase 4 continuation) is the most recent RunProgressEvent
 * this run has emitted -- absent only in the brief window before the
 * first event arrives. This is what lets GET /api/runs/:id/status return
 * live counters on reconnect (SSE dropped, or a page refresh mid-run),
 * not just static run identity.
 */
export type ActiveRunInfo = { runId: string; profileId: string; mode: RunMode; startedAt: string; lastEvent: RunProgressEvent | null };

type ActiveRun = {
  runId: string;
  profileId: string;
  mode: RunMode;
  startedAt: string;
  controller: AbortController;
  listeners: Set<(event: RunProgressEvent) => void>;
  lastEvent: RunProgressEvent | null;
};

function limitsMatch(a: ProjectProfile["limits"], b: ProjectProfile["limits"] | undefined): boolean {
  if (!b) return false;
  return (
    a.maxActions === b.maxActions &&
    a.maxModelCalls === b.maxModelCalls &&
    a.maxPages === b.maxPages &&
    a.maxFindings === b.maxFindings &&
    a.maxDurationMs === b.maxDurationMs &&
    a.maxCriticCalls === b.maxCriticCalls
  );
}

/**
 * The ONE place that owns run lifecycle for the UI (Phase 4 Milestone B).
 * Deliberately a thin cancellable wrapper around the exact same
 * runPipeline() + assembleReport() functions src/index.ts's CLI calls --
 * not a second, hand-rolled "start/track/stop a run" implementation that
 * happens to call the same downstream functions. If the CLI and the UI
 * ever produce different report semantics, it can only be because
 * runPipeline()/assembleReport() themselves changed, not because this
 * class reimplemented any part of the orchestrator/RunContext lifecycle.
 */
export class RunManager {
  private current?: ActiveRun;
  /**
   * 2026-09-14 addendum fix: closes a confirmed TOCTOU race. `startRun()`
   * used to check `this.current` synchronously, then `await
   * runPreflight(...)`, then only assign `this.current` afterward -- a
   * second concurrent call could pass the guard during that await window
   * (and, compounded by generateRunId()'s prior second-level resolution,
   * could even collide on the same runId/runDir). Setting this flag
   * synchronously, before any `await`, and checking it alongside
   * `this.current` closes the window completely: the guard-check-and-
   * reserve is now one synchronous unit.
   */
  private starting = false;

  constructor(
    private readonly profileStore: ProfileStore,
    private readonly runsRootDir: string = resolve("runs")
  ) {}

  getActiveRun(): ActiveRunInfo | undefined {
    if (!this.current) return undefined;
    const { runId, profileId, mode, startedAt, lastEvent } = this.current;
    return { runId, profileId, mode, startedAt, lastEvent };
  }

  /** For SSE: returns an unsubscribe function. Events for a run that has already finished are simply never delivered (no historical replay -- reconnect uses the polling status endpoint instead, per spec). */
  subscribe(runId: string, listener: (event: RunProgressEvent) => void): () => void {
    if (this.current?.runId !== runId) return () => {};
    this.current.listeners.add(listener);
    return () => this.current?.listeners.delete(listener);
  }

  async startRun(input: StartRunInput): Promise<{ runId: string }> {
    if (this.current || this.starting) throw new RunAlreadyActiveError();
    this.starting = true;

    try {
      const profile = this.profileStore.load(input.profileId);

      if (input.mode === "live" && !limitsMatch(profile.limits, input.confirmedLimits)) {
        throw new LiveModeNotConfirmedError();
      }

      let workflowManifest = loadWorkflowManifest(this.profileStore.getDir(), profile.id);
      if (input.workflowIds) {
        if (new Set(input.workflowIds).size !== input.workflowIds.length || input.workflowIds.some(id => !workflowManifest?.workflows.some(w => w.id === id))) throw new Error("Invalid workflow selection");
        workflowManifest = workflowManifest ? { ...workflowManifest, workflows: workflowManifest.workflows.filter(w => input.workflowIds!.includes(w.id)) } : undefined;
      }
      if (input.authenticationOnly) workflowManifest = workflowManifest ? { ...workflowManifest, workflows: [] } : undefined;
      if (profile.workflows.executionMode === "declared" && !input.authenticationOnly && !workflowManifest?.workflows.length) throw new Error("No observed workflows configured. Run authentication-only acceptance first.");
      const config = profileToAppConfig(profile);
      if (input.mode === "demo") {
        // Demo mode is a hard safety property, not just a UI label: force
        // deterministic mock providers regardless of what the profile's own
        // provider selection says, so a demo run can never make a live call.
        config.models.explorer = { ...config.models.explorer, provider: "mock" };
        config.models.critic = { ...config.models.critic, provider: "mock" };
      }

      // Enforced here, not just advisory in the UI's own "Check setup"
      // button (Phase 4 continuation fix) -- checked against the EFFECTIVE
      // selected mode, so Demo mode (mock providers forced above) never
      // needs live credentials to pass. "managed"/"skipped" never block.
      const preflight = await runPreflight(profile, config, createLogger());
      const failedChecks = preflight.checks.filter((c) => c.status === "fail");
      if (failedChecks.length > 0) {
        throw new PreflightFailedError(failedChecks);
      }

      const startedAt = new Date();
      const runId = generateRunId(startedAt);
      const runDir = join(this.runsRootDir, runId);
      ensureDir(runDir);
      if (workflowManifest) snapshotManifest(runDir, workflowManifest, credentialSecrets(input.credentials));
      // A UI-submitted credential never touches process.env (see
      // TransientCredentials/redact.ts#credentialSecrets) -- this logger is
      // built with the actual per-run values so every line it writes is
      // scrubbed the same way an env-sourced QA_PASSWORD already was.
      const logger = createLogger(join(runDir, "run.log"), credentialSecrets(input.credentials));

      const actionPolicy = profile.target.environmentKind !== "local-fixture" ? new ActionPolicy(profile, workflowManifest) : undefined;
      const sessionAuth =
        profile.auth.mode !== "none"
          ? { sessionBootstrap: profile.auth.mode === "form-login" ? new FormLoginBootstrap() : new NoAuthBootstrap(), profile, credentials: input.credentials }
          : undefined;

      const controller = new AbortController();
      const active: ActiveRun = { runId, profileId: input.profileId, mode: input.mode, startedAt: startedAt.toISOString(), controller, listeners: new Set(), lastEvent: null };
      this.current = active;

      void this.executeRun(profile, config, runId, runDir, logger, startedAt, controller, actionPolicy, sessionAuth, active, credentialSecrets(input.credentials), workflowManifest, input.authenticationOnly).finally(() => {
        if (this.current?.runId === runId) this.current = undefined;
      });

      return { runId };
    } finally {
      this.starting = false;
    }
  }

  /** Returns false if runId isn't the active run (already finished, or never existed) -- the caller can tell "nothing to stop" from "stopped". */
  stopRun(runId: string): boolean {
    if (this.current?.runId !== runId) return false;
    this.current.controller.abort();
    return true;
  }

  private async executeRun(
    profile: ProjectProfile,
    config: ReturnType<typeof profileToAppConfig>,
    runId: string,
    runDir: string,
    logger: Logger,
    startedAt: Date,
    controller: AbortController,
    actionPolicy: ActionPolicy | undefined,
    sessionAuth: { sessionBootstrap: import("./auth/session-bootstrap.js").SessionBootstrap; profile: ProjectProfile; credentials?: TransientCredentials } | undefined,
    active: ActiveRun,
    extraSecrets: readonly string[],
    workflowManifest?: WorkflowManifest,
    authenticationOnly?: boolean
  ): Promise<void> {
    const emit = (event: RunProgressEvent): void => {
      active.lastEvent = event;
      for (const listener of active.listeners) listener(event);
    };

    // 2026-09-14 addendum fix: declared here (not `const` inside the try)
    // so the catch block below can consult it -- if runPipeline() itself
    // completed (with real provider requests already recorded in its
    // usageTracker) and only assembleReport() failed afterward, the
    // fallback summary must reflect what actually happened, not
    // unconditionally claim zero usage.
    let pipelineResult: PipelineResult | undefined;

    try {
      pipelineResult = await runPipeline({
        config,
        runId,
        runDir,
        logger,
        headless: true,
        workflowManifest,
        authenticationOnly,
        onProgress: emit,
        ...(actionPolicy ? { actionPolicy } : {}),
        ...(sessionAuth ? { sessionAuth } : {}),
        abortSignal: controller.signal,
      });
      assembleReport(pipelineResult, config, runId, runDir, startedAt, profile, extraSecrets, this.profileStore.getDir());
    } catch (error) {
      // runPipeline() itself only throws for a genuine setup failure
      // (ConfigError/BrowserLaunchError from provider selection or
      // Chromium launch, or an unexpected internal error) -- everything
      // reachable once the Orchestrator's FSM starts (including auth
      // failure) already resolves to a terminal ctx.state and flows
      // through assembleReport() normally. A partial run must still leave
      // a readable record, never silently vanish.
      const message = error instanceof ConfigError || error instanceof BrowserLaunchError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error);
      logger.error({ error: message }, "Run failed before producing a report");

      const usageSummary = pipelineResult?.usageTracker.summary();
      const costEstimate = usageSummary
        ? estimateRunCostUsd(config.models.explorer.model, config.models.critic.enabled ? config.models.critic.model : undefined, usageSummary)
        : undefined;
      const usage = usageSummary
        ? {
            explorer: usageSummary.explorer,
            critic: usageSummary.critic,
            estimatedCostUsd: costEstimate?.estimatedCostUsd ?? null,
            costDisclosure: `Run failed after runPipeline() completed (${message}); usage below reflects actual measured requests before the failure, not necessarily the full intended run. ${costEstimate?.disclosure ?? ""}`.trim(),
          }
        : {
            explorer: { requests: 0, tokenUsage: null },
            critic: { requests: 0, tokenUsage: null },
            estimatedCostUsd: 0,
            costDisclosure: "Run failed before any provider request was attempted.",
          };

      const fallback: RunSummary = {
        runId,
        project: profile.name,
        target: profile.target.url,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        status: "failed",
        stopReason: message,
        provider: "unknown",
        actionsPerformed: pipelineResult?.budget.actionsPerformed ?? 0,
        modelCalls: pipelineResult?.budget.modelCalls ?? 0,
        suspectedFindings: 0,
        validatedFindings: 0,
        rejectedFindings: 0,
        needsHuman: 0,
        reportDispositionBreakdown: { report: 0, suppress: 0, needs_human: 0 },
        coverage: { pagesDiscovered: 0, pagesVisited: 0, interactiveControlsDiscovered: 0, heuristicsApplicable: 0, heuristicsExecuted: 0, heuristicCoverage: 0 },
        budget: pipelineResult
          ? pipelineResult.budget.snapshot()
          : {
              maxActions: config.agent.maxActions,
              maxModelCalls: config.agent.maxModelCalls,
              maxPages: config.agent.maxPages,
              maxFindings: config.agent.maxFindings,
              maxDurationMs: config.agent.maxDurationMs,
              maxCriticCalls: config.agent.maxCriticCalls,
              actionsUsed: 0,
              modelCallsUsed: 0,
              pagesUsed: 0,
              findingsUsed: 0,
              durationMs: Date.now() - startedAt.getTime(),
              criticCallsUsed: 0,
            },
        usage,
      };
      writeRunSummary(runDir, fallback);
      emit({ phase: "failed", detail: message, pagesVisited: 0, actionsPerformed: 0, remainingActions: 0, remainingDurationMs: 0, reportableCount: 0, needsReviewCount: 0 });
    }
  }

  /**
   * Existing JSON artifacts supply run history -- no new persistence
   * layer. A run whose directory exists but was never finished with a
   * summary written (the process died mid-run, so no in-memory ActiveRun
   * survived to call assembleReport()) is synthesized as "interrupted" at
   * read time, rather than silently vanishing from the list -- real
   * recovery isn't implemented, so this is an honest read-time
   * reconciliation, not a claim the run resumed.
   */
  listRuns(): Array<Omit<RunSummary, "status"> & { status: RunSummary["status"] | "interrupted" }> {
    if (!existsSync(this.runsRootDir)) return [];
    const runIds = readdirSync(this.runsRootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    const summaries: Array<Omit<RunSummary, "status"> & { status: RunSummary["status"] | "interrupted" }> = [];
    for (const runId of runIds) {
      const summaryPath = join(this.runsRootDir, runId, "run-summary.json");
      const isActiveRun = this.current?.runId === runId;

      if (!existsSync(summaryPath)) {
        // A run directory with no run-summary.json at all is either the
        // currently-active run (not finished yet -- omitted here, the
        // caller uses getActiveRun()/subscribe() for that) or a genuinely
        // interrupted one from a prior process.
        if (isActiveRun) continue;
        summaries.push({
          runId,
          project: "(unknown -- run was interrupted before a summary was written)",
          target: "(unknown)",
          startedAt: "",
          finishedAt: "",
          status: "interrupted",
          provider: "(unknown)",
          actionsPerformed: 0,
          modelCalls: 0,
          suspectedFindings: 0,
          validatedFindings: 0,
          rejectedFindings: 0,
          needsHuman: 0,
          reportDispositionBreakdown: { report: 0, suppress: 0, needs_human: 0 },
          coverage: { pagesDiscovered: 0, pagesVisited: 0, interactiveControlsDiscovered: 0, heuristicsApplicable: 0, heuristicsExecuted: 0, heuristicCoverage: 0 },
          budget: { maxActions: 0, maxModelCalls: 0, maxPages: 0, maxFindings: 0, maxDurationMs: 0, maxCriticCalls: 0, actionsUsed: 0, modelCallsUsed: 0, pagesUsed: 0, findingsUsed: 0, durationMs: 0, criticCallsUsed: 0 },
          usage: {
            explorer: { requests: 0, tokenUsage: null },
            critic: { requests: 0, tokenUsage: null },
            estimatedCostUsd: null,
            costDisclosure: "Unknown -- this run directory has no summary; usage was never recorded before the process was interrupted.",
          },
        });
        continue;
      }

      try {
        const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as RunSummary;
        summaries.push(summary);
      } catch {
        // A run directory with a corrupt/partial run-summary.json is skipped, not crashed on.
      }
    }
    return summaries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }
}
