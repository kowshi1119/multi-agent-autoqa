import { writeFileSync } from "node:fs";
import { checkCompletion, recordWorkflow } from "../pilot/workflow-runtime.js";
import type { WorkflowManifest, WorkflowRunStatus } from "../pilot/workflow-manifest.js";
import { redactSecrets } from "../redact.js";
import { join } from "node:path";
import { executeAction, isCancellationError, isOriginAllowed, NAVIGATION_TIMEOUT_MS } from "../actions.js";
import type { SessionBootstrap, TransientCredentials } from "../auth/session-bootstrap.js";
import { AuthenticationError, type BrowserManager, type PageSession, type StorageState } from "../browser/browser.js";
import { observe } from "../browser/observation.js";
import type { BudgetTracker } from "../budget.js";
import type { AppConfig } from "../config.js";
import { Critic, deriveTimeoutSignal } from "../critic/critic-runner.js";
import { evidenceLevelForOracle } from "../critic/evidence-level.js";
import { ensureDir, writeFindingEvidence } from "../evidence.js";
import { Explorer } from "../explorer.js";
import type { Logger } from "../logger.js";
import { credentialSecrets } from "../redact.js";
import { PageMapper } from "../mapping/mapper.js";
import type { ModelRouter } from "../models/model-router.js";
import type { Oracle } from "../oracles.js";
import { markExecuted } from "../qa/heuristic-tracker.js";
import type { QaHeuristic } from "../qa/heuristics.js";
import { Planner } from "../qa/planner.js";
import type { ProjectProfile } from "../profiles/schema.js";
import { phaseForState, reportableAndNeedsReviewCounts, type RunProgressEvent } from "../progress.js";
import { buildFindingNarrative, buildFindingTitle, categoryForOracle, generateFindingId, writeFindingJson } from "../report.js";
import { dedupKeyForFinding, findExistingFinding } from "../reporting/dedup.js";
import type { ActionPolicy } from "../safety/action-policy.js";
import type { Finding, Observation, OracleResult, RecordedStep, RequirementRule, SafetyEvent, TestCandidate } from "../types.js";
import { Validator } from "../validator.js";
import { assertValidTransition, type QaState } from "./states.js";
import type { RunContext } from "./run-context.js";

export type OrchestratorDeps = {
  workflowManifest?: WorkflowManifest;
  authenticationOnly?: boolean;
  browserManager: BrowserManager;
  config: AppConfig;
  modelRouter: ModelRouter;
  logger: Logger;
  oracles: Oracle[];
  heuristics: QaHeuristic[];
  budget: BudgetTracker;
  mapper: PageMapper;
  runDir: string;
  requirements: RequirementRule[];
  /**
   * Structured progress events (Phase 4 Milestone B) -- never raw model
   * chain-of-thought, only structured decisions/results. `.detail` is the
   * same human-readable line the CLI has always printed via
   * console.log(event.detail); the rest of the fields are new, real
   * counters (never a fabricated percent-complete) the UI renders.
   */
  onProgress?: (event: RunProgressEvent) => void;
  /** Real-target action safety (Phase 4 Milestone A2) -- absent for a local-fixture profile/legacy direct-YAML run, preserving today's behavior exactly. */
  actionPolicy?: ActionPolicy;
  /** Session bootstrap / authentication (Phase 4 Milestone A3) -- absent for a no-auth profile/legacy direct-YAML run. */
  sessionAuth?: { sessionBootstrap: SessionBootstrap; profile: ProjectProfile; credentials?: TransientCredentials };
  /** UI-driven stop (Phase 4 Milestone B) -- checked between FSM steps and between Validator replay attempts; absent for a CLI run (never aborts). */
  abortSignal?: AbortSignal;
};

/** Bounded workflow-prerequisite replay cap (Phase 4 continuation, §4b) -- see Orchestrator#computePrerequisitePrefix. */
const PREREQUISITE_PREFIX_MAX_STEPS = 8;

/**
 * Pure filter+anchor+cap logic factored out of Orchestrator#computePrerequisitePrefix
 * so it's directly unit-testable without standing up a full Orchestrator run
 * (§7b fix, 2026-09-14 addendum). See that method's own doc comment for why
 * this filters to successful steps and anchors on the most recent navigate.
 */
export function selectPrerequisitePrefix(priorSteps: RecordedStep[]): RecordedStep[] | undefined {
  if (priorSteps.length === 0) return undefined;
  const successfulSteps = priorSteps.filter((step) => step.outcome === "success" || step.outcome === undefined);
  if (successfulSteps.length === 0) return undefined;
  const lastNavigateIndex = successfulSteps.map((step) => step.action.type).lastIndexOf("navigate");
  const anchored = lastNavigateIndex === -1 ? successfulSteps : successfulSteps.slice(lastNavigateIndex);
  return anchored.slice(-PREREQUISITE_PREFIX_MAX_STEPS);
}

/** Ephemeral per-cycle scratch data (before/after observation, chosen candidate). Reset at the top of every CONTINUE -> MAP transition. */
type CycleState = {
  before?: Observation;
  after?: Observation;
  candidates?: TestCandidate[];
  chosenCandidate?: TestCandidate;
  stepsThisCycle: RecordedStep[];
  suspiciousResult?: OracleResult;
  pendingEdge?: { fromPageId: string; action: { type: string; label?: string } };
  recordedFinding?: Finding;
  wasDuplicate?: boolean;
};

function freshCycle(): CycleState {
  return { stepsThisCycle: [] };
}

/**
 * Deterministic top-level FSM. The Explorer (LLM) operates only inside
 * EXPLORE, choosing a candidate id from a list the Planner already built —
 * it never chooses a state transition directly. A validated/rejected
 * finding does not end the run; CONTINUE decides whether to loop back to
 * MAP or stop, based purely on budgets and the Explorer's own "stop" pick.
 */
export class Orchestrator {
  private readonly explorer: Explorer;
  private readonly planner: Planner;
  private session!: PageSession;
  private readonly safetyEvents: SafetyEvent[] = [];
  private cycle: CycleState = freshCycle();
  /** Captured once, right after a successful initial login, so Validator's per-attempt fresh contexts can reuse it instead of re-running the full login every replay (see validateFinding()). */
  private authStorageState?: StorageState;
  /** This run's transient, non-env credential values (Phase 4 continuation secret-hygiene fix) -- scrubbed from evidence/logs on top of the existing env-derived redaction, never written to process.env. */
  private readonly extraSecrets: string[];
  private readonly completedWorkflows = new Set<string>();
  private readonly runSignal: AbortSignal;

  constructor(private readonly deps: OrchestratorDeps) {
    this.runSignal = deriveTimeoutSignal(deps.budget.remainingDurationMs(), deps.abortSignal);
    this.explorer = new Explorer(deps.modelRouter.getExplorer(), deps.logger);
    this.extraSecrets = credentialSecrets(deps.sessionAuth?.credentials);
    this.planner = new Planner(deps.heuristics, deps.config, this.extraSecrets, deps.actionPolicy, deps.workflowManifest);
  }

  getSafetyEvents(): SafetyEvent[] {
    return [...this.safetyEvents];
  }

  private progress(ctx: RunContext, detail: string): void {
    if (!this.deps.onProgress) return;
    const { reportableCount, needsReviewCount } = reportableAndNeedsReviewCounts(ctx.findings);
    const event: RunProgressEvent = {
      phase: phaseForState(ctx.state),
      detail,
      pagesVisited: ctx.pagesVisited,
      actionsPerformed: ctx.actionsPerformed,
      remainingActions: Math.max(0, this.deps.config.agent.maxActions - ctx.actionsPerformed),
      remainingDurationMs: Math.max(0, this.deps.config.agent.maxDurationMs - this.deps.budget.elapsedMs()),
      reportableCount,
      needsReviewCount,
    };
    this.deps.onProgress(event);
  }

  async closeSession(): Promise<void> {
    if (this.session) {
      await this.deps.browserManager.closeSession(this.session);
    }
  }

  async run(ctx: RunContext): Promise<RunContext> {
    ctx = await this.initialize(ctx);
    if (this.deps.authenticationOnly && ctx.state === "MAP") {
      ctx = { ...ctx, state: "COMPLETE", stopReason: "AUTHENTICATION_ONLY: verified session" };
      this.progress(ctx, "Authentication acceptance completed");
    }

    while (ctx.state !== "COMPLETE" && ctx.state !== "FAILED" && ctx.state !== "CANCELLED") {
      if (this.runSignal.aborted) {
        this.deps.logger.info({}, "CANCELLED: stop requested");
        ctx = this.transition(ctx, this.deps.abortSignal?.aborted ? "CANCELLED" : "FAILED", { stopReason: this.deps.abortSignal?.aborted ? "CANCELLED: stop requested by user" : "BUDGET_EXHAUSTED: maxDurationMs" });
        // Emitted AFTER transitioning (Phase 4 continuation fix, confirmed
        // via a real-browser UI walkthrough): this.progress() derives its
        // phase from ctx.state via phaseForState(), so calling it on the
        // OLD (pre-transition) ctx here produced phase:"exploring" instead
        // of "stopped" -- the client's SSE listener only ever calls
        // finishRun() on a terminal phase, so the UI simply froze on the
        // last real progress line and never learned the run had ended
        // without a manual page reload.
        this.progress(ctx, "Stopping: cancelled by user");
        break;
      }
      ctx = { ...ctx, elapsedMs: this.deps.budget.elapsedMs() };
      try {
        ctx = await this.step(ctx);
      } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        // A step that was genuinely aborted mid-flight (Stop pressed while
        // an Explorer/Critic SDK call was in progress -- see
        // deriveTimeoutSignal()) throws an AbortError here rather than
        // silently ignoring the signal. Distinguish that from a real
        // internal failure so the run's terminal status honestly reflects
        // "cancelled", not "failed".
        if (this.deps.abortSignal?.aborted) {
          this.deps.logger.info({ state: ctx.state }, "CANCELLED: step aborted by user Stop");
          ctx = this.transition(ctx, "CANCELLED", { stopReason: "CANCELLED: stop requested by user" });
          this.progress(ctx, "Stopping: cancelled by user");
        } else {
          this.deps.logger.error({ error: message, state: ctx.state }, "Orchestrator step failed");
          ctx = this.transition(ctx, "FAILED", { stopReason: `INTERNAL_ERROR in state ${ctx.state}: ${message}` });
          this.progress(ctx, `Failed: ${message}`);
        }
      }
    }

    for (const workflow of this.deps.workflowManifest?.workflows ?? []) {
      if (!this.completedWorkflows.has(workflow.id)) {
        const denied = workflow.execution?.steps.map(s => this.deps.actionPolicy?.classifyPlannedAction(s.action, s.pathname)).find(c => c?.decision === "denied");
        const reason = denied?.decision === "denied" ? denied.reason : ctx.stopReason ?? "Starting state not reached";
        this.finishWorkflow(workflow.id, workflow.execution ? "blocked" : "unsupported", workflow.execution ? reason : "No executable capability declared", {});
      }
    }
    ctx.actionsPerformed = this.deps.budget.actionsPerformed;
    return ctx;
  }

  private finishWorkflow(id: string, status: WorkflowRunStatus, reason: string, evidence: unknown): void {
    recordWorkflow(this.deps.runDir, id, status, reason, evidence, this.extraSecrets);
    this.completedWorkflows.add(id); this.planner.markWorkflowHandled(id);
  }

  private step(ctx: RunContext): Promise<RunContext> {
    switch (ctx.state) {
      case "MAP":
        return this.map(ctx);
      case "PLAN":
        return this.plan(ctx);
      case "EXPLORE":
        return this.explore(ctx);
      case "EXECUTE":
        return this.execute(ctx);
      case "OBSERVE":
        return this.observeAfter(ctx);
      case "EVALUATE":
        return this.evaluate(ctx);
      case "VALIDATE":
        return this.validateFinding(ctx);
      case "RECORD_FINDING":
        return this.recordFinding(ctx);
      case "CONTINUE":
        return Promise.resolve(this.continueOrStop(ctx));
      default:
        throw new Error(`Orchestrator: no step handler for state "${ctx.state}"`);
    }
  }

  private transition(ctx: RunContext, to: QaState, patch: Partial<RunContext> = {}): RunContext {
    assertValidTransition(ctx.state, to);
    return { ...ctx, ...patch, state: to };
  }

  private async initialize(ctx: RunContext): Promise<RunContext> {
    const { sessionAuth } = this.deps;
    const authEvidence = (status: string, reason?: string) => writeFileSync(join(this.deps.runDir, "authentication.json"), redactSecrets(JSON.stringify({ status, reason, checks: sessionAuth ? { urlAndVisibleSignalRequired: true, passed: status === "success" } : undefined, authenticatedUrl: status === "success" ? this.session.page.url() : undefined, recordedAt: new Date().toISOString(), actions: this.deps.budget.snapshot().actionsByPhase?.authentication ?? 0 }, null, 2), this.extraSecrets));
    try {
      this.session = await this.deps.browserManager.newPageSession(
        (event) => this.safetyEvents.push(event),
        this.deps.actionPolicy,
        sessionAuth ? { sessionBootstrap: sessionAuth.sessionBootstrap, profile: sessionAuth.profile, credentials: sessionAuth.credentials } : undefined,
        this.runSignal
      );
    } catch (error) {
      if (error instanceof AuthenticationError) {
        authEvidence("failed", error.reason);
        // §Cancellation fix (2026-09-16): a login genuinely interrupted by
        // Stop surfaces here as AuthenticationError with reason "cancelled"
        // (see BrowserManager#ensureAuthenticated / FormLoginBootstrap) --
        // this must transition to CANCELLED, never FAILED. A cancelled
        // run's report says "stopped", never "failed" (see states.ts's own
        // doc comment); mapping it to FAILED here was a pre-existing bug
        // exposed while wiring genuine mid-step cancellation, not something
        // this fix introduced.
        if (error.reason === "cancelled") {
          this.deps.logger.info({}, "CANCELLED: stop requested during login");
          return this.transition(ctx, this.deps.abortSignal?.aborted ? "CANCELLED" : "FAILED", { stopReason: this.deps.abortSignal?.aborted ? "CANCELLED: stop requested during login" : "BUDGET_EXHAUSTED: maxDurationMs during login" });
        }
        this.deps.logger.error({ reason: error.reason }, "AUTH_FAILED");
        return this.transition(ctx, "FAILED", { stopReason: error.message });
      }
      throw error;
    }

    authEvidence(sessionAuth ? "success" : "not-required");
    if (this.deps.authenticationOnly) return this.transition(ctx, "MAP");
    if (sessionAuth) {
      // Captured once, right after login, so Validator's fresh per-attempt
      // contexts can reuse it (protected-page-accessibility re-verified
      // each time, not trusted blindly) instead of re-running the full
      // login every single replay attempt.
      this.authStorageState = await this.session.context.storageState();
    }

    if (this.deps.actionPolicy?.isDeclaredMode() && !this.deps.budget.canAct()) return this.transition(ctx, "FAILED", { stopReason: "BUDGET_EXHAUSTED: no action budget remains after authentication" });
    try {
      if (this.deps.actionPolicy?.isDeclaredMode()) this.deps.budget.recordAttempt("setup");
      await this.session.page.goto(this.deps.config.target.url, {
        timeout: NAVIGATION_TIMEOUT_MS,
        signal: this.runSignal,
      });
      if (this.deps.actionPolicy?.isDeclaredMode()) this.deps.budget.recordOutcome("success");
    } catch (error) {
      if (this.deps.actionPolicy?.isDeclaredMode()) this.deps.budget.recordOutcome("failed");
      if (isCancellationError(error)) {
        return this.transition(ctx, this.deps.abortSignal?.aborted ? "CANCELLED" : "FAILED", { stopReason: this.deps.abortSignal?.aborted ? "CANCELLED: stop requested during initial navigation" : "BUDGET_EXHAUSTED: maxDurationMs during initial navigation" });
      }
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error({ error: message, url: this.deps.config.target.url }, "TARGET_ERROR");
      return this.transition(ctx, "FAILED", { stopReason: `TARGET_ERROR: ${message}` });
    }
    return this.transition(ctx, "MAP");
  }

  private async map(ctx: RunContext): Promise<RunContext> {
    const auth = this.deps.sessionAuth?.profile.auth;
    if (auth?.mode === "form-login" && new URL(this.session.page.url()).pathname === new URL(auth.loginUrl!).pathname) {
      return this.transition(ctx, "FAILED", { stopReason: "SESSION_EXPIRED: returned to login; no further workflow actions attempted" });
    }
    const observation = await observe(this.session.page, this.session.records, {}, this.extraSecrets);
    const now = new Date().toISOString();
    const pageNode = this.deps.mapper.upsertPage(observation, now);

    if (this.cycle.pendingEdge) {
      this.deps.mapper.recordEdge(this.cycle.pendingEdge.fromPageId, pageNode.id, this.cycle.pendingEdge.action);
      this.cycle.pendingEdge = undefined;
    }

    if (!ctx.visitedPages.has(observation.page.pathname)) {
      if (!this.deps.budget.canVisitNewPage()) return this.transition(ctx, "FAILED", { stopReason: "BUDGET_EXHAUSTED: maxPages" });
      ctx.visitedPages.add(observation.page.pathname);
      ctx.pagesVisited += 1;
      this.deps.budget.recordPageVisit();
      this.progress(ctx, `Visited page: ${observation.page.pathname} (${pageNode.id})`);
    }

    // Feed the Planner's frontier fallback: every same-origin link seen on
    // *any* page is remembered here, not just the current page's own links
    // — otherwise coverage would depend on every page linking directly to
    // every other page, rather than the app's actual (often hub-and-spoke)
    // link graph.
    for (const link of observation.links) {
      if (
        link.sameOrigin &&
        isOriginAllowed(link.href, this.deps.config.safety.allowedOrigins) &&
        !ctx.frontier.includes(link.href)
      ) {
        ctx.frontier.push(link.href);
      }
    }

    this.cycle.before = observation;
    return this.transition(ctx, "PLAN", { currentUrl: observation.page.url, currentPageId: pageNode.id });
  }

  private async plan(ctx: RunContext): Promise<RunContext> {
    if (!this.deps.budget.canCallModel()) {
      return this.transition(ctx, "CONTINUE", { stopReason: "BUDGET_EXHAUSTED: maxModelCalls" });
    }
    this.cycle.candidates = await this.planner.plan(this.cycle.before as Observation, ctx);
    return this.transition(ctx, "EXPLORE");
  }

  private async explore(ctx: RunContext): Promise<RunContext> {
    const remainingActions = this.deps.config.agent.maxActions - this.deps.budget.actionsPerformed;
    const remainingModelCalls = this.deps.config.agent.maxModelCalls - this.deps.budget.modelCalls;

    // Same timeout+Stop signal construction the Critic uses (Phase 4
    // continuation cancellation fix) -- ties the model's own configured
    // per-request timeout AND a user-initiated Stop to the real SDK call,
    // not just to this awaited Promise. 2026-09-15 fix: the request deadline
    // is now the LESSER of the provider's own configured timeout and the
    // run's remaining duration budget -- previously a request could
    // legitimately run for the full providerTimeoutMs even with almost no
    // run-duration budget left, overrunning maxDurationMs by up to that
    // amount.
    const requestDeadlineMs = Math.min(this.deps.config.models.providerTimeoutMs, this.deps.budget.remainingDurationMs());
    const signal = deriveTimeoutSignal(requestDeadlineMs, this.deps.abortSignal);
    // §4 fix (2026-09-14 addendum): a real provider now records each of its
    // own real HTTP requests at its own complete() boundary (see
    // models/provider-implementation.ts), so recording unconditionally
    // here would double-count. Diff-based fallback: only record here when
    // the provider itself consumed nothing (MockModelProvider, which makes
    // no real request at all -- preserving the existing "one model call
    // per logical decision" semantics for mock-driven runs/tests).
    const modelCallsBefore = this.deps.budget.modelCalls;
    const outcome = await this.explorer.decide(
      {
        observation: this.cycle.before as Observation,
        candidates: this.cycle.candidates ?? [],
        recentActions: ctx.recordedSteps.slice(-10),
        remainingActions,
        remainingModelCalls,
        remainingDurationMs: this.deps.budget.remainingDurationMs(),
        extraSecrets: this.extraSecrets,
      },
      signal
    );
    if (this.deps.budget.modelCalls === modelCallsBefore) {
      this.deps.budget.recordModelCall();
    }
    ctx = { ...ctx, modelCalls: this.deps.budget.modelCalls };

    if (outcome.kind === "stop") {
      const reasonText =
        outcome.stopReason.type === "model_requested_stop"
          ? outcome.stopReason.reason || "Explorer requested stop."
          : "MODEL_OUTPUT_INVALID: explorer output did not match a supplied candidate.";
      return this.transition(ctx, "CONTINUE", { stopReason: reasonText });
    }

    this.cycle.chosenCandidate = outcome.candidate;
    this.progress(ctx, `→ ${outcome.candidate.description} (${outcome.decision.testingIntent})`);

    if (!this.deps.budget.canAct()) {
      return this.transition(ctx, "CONTINUE", { stopReason: "BUDGET_EXHAUSTED: maxActions" });
    }

    return this.transition(ctx, "EXECUTE");
  }

  private async execute(ctx: RunContext): Promise<RunContext> {
    const candidate = this.cycle.chosenCandidate as TestCandidate;
    const fromPageId = ctx.currentPageId;

    const workflow = this.deps.workflowManifest?.workflows.find(w => w.id === candidate.workflowId);
    const strictAccounting = this.deps.actionPolicy?.isDeclaredMode();
    const networkBlocksBefore = this.safetyEvents.length;
    for (const [index, action] of candidate.actions.entries()) {
      if (this.runSignal.aborted || !this.deps.budget.canAct()) {
        if (workflow) this.finishWorkflow(workflow.id, "blocked", "Execution stopped by cancellation or budget", { steps: this.cycle.stepsThisCycle });
        return this.transition(ctx, "CONTINUE", { stopReason: this.deps.abortSignal?.aborted ? "CANCELLED: stop requested" : "BUDGET_EXHAUSTED: action or duration limit" });
      }
      if (workflow && workflow.execution?.steps[index]?.pathname !== new URL(this.session.page.url()).pathname) {
        this.finishWorkflow(workflow.id, "blocked", "Starting route precondition did not match", { steps: this.cycle.stepsThisCycle });
        return this.transition(ctx, "CONTINUE");
      }
      const destination = action.type === "navigate" ? new URL(action.url).pathname : workflow?.execution?.steps[index]?.resultingPathname;
      if (destination && !ctx.visitedPages.has(destination) && !this.deps.budget.canVisitNewPage()) {
        if (workflow) this.finishWorkflow(workflow.id, "blocked", "Page budget exhausted", {});
        return this.transition(ctx, "CONTINUE", { stopReason: "BUDGET_EXHAUSTED: maxPages" });
      }
      if (strictAccounting && !this.deps.budget.canVisitNewPage() && action.type === "click" && !destination) {
        if (workflow) this.finishWorkflow(workflow.id, "blocked", "At page limit: click requires an explicit resultingPathname", {});
        return this.transition(ctx, "CONTINUE", { stopReason: "BUDGET_EXHAUSTED: maxPages" });
      }
      if (strictAccounting) this.deps.budget.recordAttempt("execution");
      const result = await executeAction(
        this.session.page,
        action,
        this.deps.config,
        this.deps.logger,
        (event) => this.safetyEvents.push(event),
        this.deps.actionPolicy,
        this.extraSecrets,
        this.runSignal
      );
      if (strictAccounting) this.deps.budget.recordOutcome(result.outcome);
      else this.deps.budget.recordAction();
      ctx = { ...ctx, actionsPerformed: this.deps.budget.actionsPerformed };

      const step: RecordedStep = {
        number: this.deps.budget.actionsPerformed,
        action,
        testingIntent: candidate.description,
        timestamp: new Date().toISOString(),
        outcome: result.outcome,
      };
      ctx.recordedSteps.push(step);
      this.cycle.stepsThisCycle.push(step);

      if (result.outcome !== "success") {
        this.planner.markUnsuccessful(this.cycle.before!.stateSignature, candidate);
        if (workflow) this.finishWorkflow(workflow.id, result.outcome === "blocked" ? "blocked" : "failed", `Runner action ${result.outcome}`, { steps: this.cycle.stepsThisCycle });
        this.deps.logger.warn({ step, outcome: result }, "Action did not complete successfully");
        return this.transition(ctx, "CONTINUE");
      }
      const expectedPath = workflow?.execution?.steps[index]?.resultingPathname;
      if (expectedPath) {
        const arrived = await this.session.page.waitForURL(u => u.pathname === expectedPath, { timeout: 3000, signal: this.runSignal }).then(() => true).catch(() => false);
        if (!arrived) {
          this.finishWorkflow(workflow!.id, this.runSignal.aborted ? "blocked" : "failed", "Declared resulting route was not reached; cause requires review", { steps: this.cycle.stepsThisCycle });
          return this.transition(ctx, "CONTINUE");
        }
      }
      if (workflow && result.outcome === "success") {
        const path = new URL(this.session.page.url()).pathname;
        if (!ctx.visitedPages.has(path)) {
          if (!this.deps.budget.canVisitNewPage()) {
            this.finishWorkflow(workflow.id, "blocked", "Unexpected page exceeded declared page budget", { steps: this.cycle.stepsThisCycle });
            return this.transition(ctx, "CONTINUE", { stopReason: "BUDGET_EXHAUSTED: maxPages" });
          }
          ctx.visitedPages.add(path); ctx.pagesVisited++; this.deps.budget.recordPageVisit();
        }
      }
    }

    if (workflow && this.deps.sessionAuth?.profile.auth.loginUrl && new URL(this.session.page.url()).pathname === new URL(this.deps.sessionAuth.profile.auth.loginUrl).pathname) {
      this.finishWorkflow(workflow.id, "blocked", "SESSION_EXPIRED: returned to login", { steps: this.cycle.stepsThisCycle });
      return this.transition(ctx, "CONTINUE", { stopReason: "SESSION_EXPIRED: returned to login" });
    }
    if (workflow) {
      const assertion = await checkCompletion(this.session.page, workflow, this.runSignal);
      const blocked = this.safetyEvents.length > networkBlocksBefore;
      this.finishWorkflow(workflow.id, blocked || this.runSignal.aborted ? "blocked" : assertion.passed ? "completed" : "failed", blocked ? "Network policy blocked a request during workflow" : assertion.passed ? "Declared completion assertion passed" : "Completion assertion failed; application versus runner cause requires review", { assertion, url: redactSecrets(this.session.page.url(), this.extraSecrets), steps: this.cycle.stepsThisCycle });
    }
    if (candidate.kind === "heuristic" && candidate.trackingKey) {
      markExecuted(ctx, candidate.trackingKey);
      ctx.heuristicsExecuted += 1;
    }

    if (candidate.kind === "navigation" && fromPageId) {
      this.cycle.pendingEdge = {
        fromPageId,
        action: { type: candidate.actions[0]?.type ?? "navigate", label: candidate.description },
      };
    }

    return this.transition(ctx, "OBSERVE");
  }

  private async observeAfter(ctx: RunContext): Promise<RunContext> {
    this.cycle.after = await observe(this.session.page, this.session.records, {}, this.extraSecrets);
    return this.transition(ctx, "EVALUATE");
  }

  private async evaluate(ctx: RunContext): Promise<RunContext> {
    const lastStep = this.cycle.stepsThisCycle[this.cycle.stepsThisCycle.length - 1];
    if (!lastStep || !this.cycle.before || !this.cycle.after) {
      return this.transition(ctx, "CONTINUE");
    }

    for (const oracle of this.deps.oracles) {
      const result = await oracle.evaluate(this.cycle.before, lastStep, this.cycle.after);
      if (result.suspicious) {
        ctx.rawAnomalies = (ctx.rawAnomalies ?? 0) + 1;
        this.deps.logger.info({ oracleResult: result }, "Suspicious result detected");
        this.progress(ctx, `Oracle ${result.oracleId}: ${result.actual}`);
        this.cycle.suspiciousResult = result;
        return this.transition(ctx, "VALIDATE");
      }
    }

    return this.transition(ctx, "CONTINUE");
  }

  /**
   * Bounded workflow-prerequisite replay (Phase 4 continuation, §4b) --
   * NOT a general graph planner. Only ever the deterministic tail of this
   * same run's own already-executed step history (never a search across
   * the app graph), capped short, and only attempted for a real-target
   * profile that requires authentication (where a client-state-dependent
   * scenario -- e.g. list -> filter -> trigger -- is plausible). Absent
   * entirely for a fixture profile or a no-auth profile, leaving their
   * replay behavior unchanged.
   */
  /**
   * §7b fix (2026-09-14 addendum): the prior version was an unfiltered tail
   * slice -- it could include a step whose executeAction() was
   * blocked/failed (replaying that on a fresh session wouldn't reconstruct
   * anything real), and had no state-coherence anchor (the tail can start
   * mid-sequence, spanning a prior cycle-reset boundary). See
   * selectPrerequisitePrefix() for the actual filter+anchor+cap logic,
   * factored out as a pure function for direct unit testing.
   */
  private computePrerequisitePrefix(ctx: RunContext): RecordedStep[] | undefined {
    const sessionAuth = this.deps.sessionAuth;
    if (!sessionAuth || sessionAuth.profile.auth.mode === "none") return undefined;
    const priorSteps = ctx.recordedSteps.slice(0, ctx.recordedSteps.length - this.cycle.stepsThisCycle.length);
    return selectPrerequisitePrefix(priorSteps);
  }

  private async validateFinding(ctx: RunContext): Promise<RunContext> {
    const suspicious = this.cycle.suspiciousResult as OracleResult;
    const before = this.cycle.before as Observation;
    const candidate = this.cycle.chosenCandidate;
    const pageNode = this.deps.mapper.getByPathname(before.page.pathname);
    const narrative = buildFindingNarrative(suspicious.oracleId, {
      expected: suspicious.expected,
      actual: suspicious.actual,
    });
    const prerequisitePrefix = this.computePrerequisitePrefix(ctx);

    const candidateFinding: Finding = {
      id: "PENDING",
      title: buildFindingTitle(suspicious.oracleId),
      status: "suspected",
      category: categoryForOracle(suspicious.oracleId),
      pageId: pageNode?.id ?? "UNKNOWN",
      url: before.page.url,
      pathname: before.page.pathname,
      expected: narrative.expected,
      actual: narrative.actual,
      oracle: suspicious,
      ...(candidate?.heuristicId ? { heuristicId: candidate.heuristicId } : {}),
      ...(candidate?.controlKey ? { controlKey: candidate.controlKey } : {}),
      steps: [...this.cycle.stepsThisCycle],
      ...(prerequisitePrefix && prerequisitePrefix.length > 0 ? { prerequisitePrefix } : {}),
      reproduction: { attempts: 0, successes: 0 },
      occurrenceCount: 1,
      evidence: [],
      evidenceLevel: evidenceLevelForOracle(suspicious.oracleId, this.deps.logger),
      reportDisposition: "needs_human",
    };

    const candidateKey = dedupKeyForFinding(candidateFinding);
    const existing = findExistingFinding(ctx.findings, candidateKey);
    if (existing) {
      existing.occurrenceCount += 1;
      this.deps.logger.info(
        { findingId: existing.id, occurrenceCount: existing.occurrenceCount },
        "Duplicate finding suppressed; incremented occurrenceCount"
      );
      writeFindingJson(join(this.deps.runDir, "findings", existing.id), existing, this.extraSecrets);
      this.progress(ctx, `Duplicate of ${existing.id} (occurrence ${existing.occurrenceCount}); no new finding recorded`);
      this.cycle.wasDuplicate = true;
      this.cycle.recordedFinding = undefined;
      return this.transition(ctx, "RECORD_FINDING");
    }

    if (!this.deps.budget.canRecordFinding()) {
      this.deps.logger.info({}, "BUDGET_EXHAUSTED: maxFindings reached; not validating this suspicion further");
      this.cycle.wasDuplicate = false;
      this.cycle.recordedFinding = undefined;
      return this.transition(ctx, "RECORD_FINDING", { stopReason: "BUDGET_EXHAUSTED: maxFindings" });
    }

    const findingId = generateFindingId(ctx.findings.length + 1);
    const evidenceDir = join(this.deps.runDir, "findings", findingId);
    ensureDir(evidenceDir);
    candidateFinding.id = findingId;

    const validator = new Validator({
      browserManager: this.deps.browserManager,
      config: this.deps.config,
      oracles: this.deps.oracles,
      logger: this.deps.logger,
      evidenceDir,
      budget: this.deps.budget,
      policy: this.deps.actionPolicy,
      abortSignal: this.runSignal,
      ...(this.deps.sessionAuth
        ? {
            sessionAuth: {
              sessionBootstrap: this.deps.sessionAuth.sessionBootstrap,
              profile: this.deps.sessionAuth.profile,
              credentials: this.deps.sessionAuth.credentials,
              storageState: this.authStorageState,
            },
          }
        : {}),
    });
    const validation = await validator.validate(candidateFinding);

    const evidenceResult = writeFindingEvidence(
      evidenceDir,
      this.deps.config,
      {
        oracle: candidateFinding.oracle,
        attempts: validation.attempts,
        reproduction: validation.finding.reproduction,
        representativeAttempt: validation.representativeAttempt,
        evidenceCompleteness: validation.evidenceCompleteness,
        consoleMessages: validation.representativeEvidence.consoleMessages,
        networkRequests: validation.representativeEvidence.networkRequests,
        pageErrors: validation.representativeEvidence.pageErrors,
        visibleTextExcerpt: validation.representativeEvidence.visibleTextExcerpt,
        ...(validation.representativeEvidence.screenshotPath
          ? { screenshotPath: validation.representativeEvidence.screenshotPath }
          : {}),
        ...(validation.representativeEvidence.tracePath ? { tracePath: validation.representativeEvidence.tracePath } : {}),
      },
      this.extraSecrets
    );

    const finalizedFinding: Finding = { ...validation.finding, evidence: evidenceResult.filenames };
    const critic = new Critic({
      criticProvider: this.deps.modelRouter.getCritic(),
      config: this.deps.config,
      logger: this.deps.logger,
      requirements: this.deps.requirements,
      budget: this.deps.budget,
      extraSecrets: this.extraSecrets,
      abortSignal: this.runSignal,
    });
    const reviewedFinding = (await critic.review(finalizedFinding, validation, evidenceDir)).finding;
    writeFindingJson(evidenceDir, reviewedFinding, this.extraSecrets);
    this.progress(
      ctx,
      `Finding ${reviewedFinding.id} ${reviewedFinding.status.toUpperCase()} (${validation.finding.reproduction.successes}/${validation.finding.reproduction.attempts} reproductions)`
    );

    this.deps.budget.recordFinding();
    this.cycle.wasDuplicate = false;
    this.cycle.recordedFinding = reviewedFinding;

    return this.transition(ctx, "RECORD_FINDING");
  }

  private async recordFinding(ctx: RunContext): Promise<RunContext> {
    if (this.cycle.recordedFinding && !this.cycle.wasDuplicate) {
      ctx = { ...ctx, findings: [...ctx.findings, this.cycle.recordedFinding] };
    }

    // Declared workflows specify their own starting states; an automatic reload
    // would be an undeclared action and could lose SPA state.
    if (this.deps.actionPolicy?.isDeclaredMode()) return this.transition(ctx, "CONTINUE");
    // Restore a clean, known DOM state before continuing exploration —
    // the triggering action may have left the page half-submitted. `signal`
    // (2026-09-16 cancellation fix) makes this abort promptly instead of
    // running to its full timeout when Stop was pressed mid-reload; either
    // way the very next run() loop iteration checks abortSignal and
    // transitions to CANCELLED, so this reload's own outcome is never
    // load-bearing for the cancellation bound, only for its promptness.
    if (this.deps.actionPolicy?.isDeclaredMode() && !this.deps.budget.canAct()) return this.transition(ctx, "CONTINUE", { stopReason: "BUDGET_EXHAUSTED: maxActions" });
    try {
      if (this.deps.actionPolicy?.isDeclaredMode()) this.deps.budget.recordAttempt("setup");
      await this.session.page.reload({
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
        signal: this.deps.abortSignal,
      });
      if (this.deps.actionPolicy?.isDeclaredMode()) this.deps.budget.recordOutcome("success");
    } catch (error) {
      if (this.deps.actionPolicy?.isDeclaredMode()) this.deps.budget.recordOutcome("failed");
      if (!isCancellationError(error)) {
        this.deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to reload exploring page after recording a finding; continuing anyway"
        );
      }
    }

    return this.transition(ctx, "CONTINUE", ctx.stopReason ? { stopReason: ctx.stopReason } : {});
  }

  private continueOrStop(ctx: RunContext): RunContext {
    const budget = this.deps.budget;
    let stopReason = ctx.stopReason;

    if (!stopReason) {
      if (budget.isDurationExceeded()) stopReason = "BUDGET_EXHAUSTED: maxDurationMs";
      else if (!budget.canAct()) stopReason = "BUDGET_EXHAUSTED: maxActions";
      else if (!budget.canCallModel()) stopReason = "BUDGET_EXHAUSTED: maxModelCalls";
      else if (!budget.canRecordFinding()) stopReason = "BUDGET_EXHAUSTED: maxFindings";
    }

    if (stopReason) {
      this.deps.logger.info({ stopReason }, "Stopping run");
      // Transition FIRST, then emit progress against the NEW ctx (Phase 4
      // continuation fix, confirmed via a real-browser walkthrough): with
      // the old order, phaseForState(ctx.state) still saw the pre-transition
      // state (e.g. CONTINUE, which maps to "exploring"), so the client
      // never received a phase:"completed" SSE event and the UI froze on
      // the last exploring line -- indefinitely, since the SSE connection
      // itself is never explicitly closed by the server either.
      const completed = this.transition(ctx, "COMPLETE", { stopReason });
      this.progress(completed, `Stopping: ${stopReason}`);
      return completed;
    }

    this.cycle = freshCycle();
    return this.transition(ctx, "MAP");
  }
}
