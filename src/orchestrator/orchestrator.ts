import { join } from "node:path";
import { executeAction, isOriginAllowed } from "../actions.js";
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

  constructor(private readonly deps: OrchestratorDeps) {
    this.explorer = new Explorer(deps.modelRouter.getExplorer(), deps.logger);
    this.planner = new Planner(deps.heuristics, deps.config);
    this.extraSecrets = credentialSecrets(deps.sessionAuth?.credentials);
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

    while (ctx.state !== "COMPLETE" && ctx.state !== "FAILED" && ctx.state !== "CANCELLED") {
      if (this.deps.abortSignal?.aborted) {
        this.progress(ctx, "Stopping: cancelled by user");
        this.deps.logger.info({}, "CANCELLED: stop requested");
        ctx = this.transition(ctx, "CANCELLED", { stopReason: "CANCELLED: stop requested by user" });
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
        } else {
          this.deps.logger.error({ error: message, state: ctx.state }, "Orchestrator step failed");
          ctx = this.transition(ctx, "FAILED", { stopReason: `INTERNAL_ERROR in state ${ctx.state}: ${message}` });
        }
      }
    }

    return ctx;
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
    try {
      this.session = await this.deps.browserManager.newPageSession(
        (event) => this.safetyEvents.push(event),
        this.deps.actionPolicy,
        sessionAuth ? { sessionBootstrap: sessionAuth.sessionBootstrap, profile: sessionAuth.profile, credentials: sessionAuth.credentials } : undefined
      );
    } catch (error) {
      if (error instanceof AuthenticationError) {
        this.deps.logger.error({ reason: error.reason }, "AUTH_FAILED");
        return this.transition(ctx, "FAILED", { stopReason: error.message });
      }
      throw error;
    }

    if (sessionAuth) {
      // Captured once, right after login, so Validator's fresh per-attempt
      // contexts can reuse it (protected-page-accessibility re-verified
      // each time, not trusted blindly) instead of re-running the full
      // login every single replay attempt.
      this.authStorageState = await this.session.context.storageState();
    }

    try {
      await this.session.page.goto(this.deps.config.target.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error({ error: message, url: this.deps.config.target.url }, "TARGET_ERROR");
      return this.transition(ctx, "FAILED", { stopReason: `TARGET_ERROR: ${message}` });
    }
    return this.transition(ctx, "MAP");
  }

  private async map(ctx: RunContext): Promise<RunContext> {
    const observation = await observe(this.session.page, this.session.records, {}, this.extraSecrets);
    const now = new Date().toISOString();
    const pageNode = this.deps.mapper.upsertPage(observation, now);

    if (this.cycle.pendingEdge) {
      this.deps.mapper.recordEdge(this.cycle.pendingEdge.fromPageId, pageNode.id, this.cycle.pendingEdge.action);
      this.cycle.pendingEdge = undefined;
    }

    if (!ctx.visitedPages.has(observation.page.pathname)) {
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
    // not just to this awaited Promise.
    const signal = deriveTimeoutSignal(this.deps.config.models.providerTimeoutMs, this.deps.abortSignal);
    const outcome = await this.explorer.decide(
      {
        observation: this.cycle.before as Observation,
        candidates: this.cycle.candidates ?? [],
        recentActions: ctx.recordedSteps.slice(-10),
        remainingActions,
        remainingModelCalls,
        remainingDurationMs: this.deps.budget.remainingDurationMs(),
      },
      signal
    );
    this.deps.budget.recordModelCall();
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

    for (const action of candidate.actions) {
      const result = await executeAction(
        this.session.page,
        action,
        this.deps.config,
        this.deps.logger,
        (event) => this.safetyEvents.push(event),
        this.deps.actionPolicy,
        this.extraSecrets
      );
      this.deps.budget.recordAction();
      ctx = { ...ctx, actionsPerformed: this.deps.budget.actionsPerformed };

      const step: RecordedStep = {
        number: this.deps.budget.actionsPerformed,
        action,
        testingIntent: candidate.description,
        timestamp: new Date().toISOString(),
      };
      ctx.recordedSteps.push(step);
      this.cycle.stepsThisCycle.push(step);

      if (result.outcome !== "success") {
        this.deps.logger.warn({ step, outcome: result }, "Action did not complete successfully");
        return this.transition(ctx, "CONTINUE");
      }
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
        this.deps.logger.info({ oracleResult: result }, "Suspicious result detected");
        this.progress(ctx, `Oracle ${result.oracleId}: ${result.actual}`);
        this.cycle.suspiciousResult = result;
        return this.transition(ctx, "VALIDATE");
      }
    }

    return this.transition(ctx, "CONTINUE");
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
      writeFindingJson(join(this.deps.runDir, "findings", existing.id), existing);
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
      ...(this.deps.abortSignal ? { abortSignal: this.deps.abortSignal } : {}),
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
      ...(this.deps.abortSignal ? { abortSignal: this.deps.abortSignal } : {}),
    });
    const reviewedFinding = (await critic.review(finalizedFinding, validation, evidenceDir)).finding;
    writeFindingJson(evidenceDir, reviewedFinding);
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

    // Restore a clean, known DOM state before continuing exploration —
    // the triggering action may have left the page half-submitted.
    try {
      await this.session.page.reload({ waitUntil: "domcontentloaded" });
    } catch (error) {
      this.deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to reload exploring page after recording a finding; continuing anyway"
      );
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
      this.progress(ctx, `Stopping: ${stopReason}`);
      return this.transition(ctx, "COMPLETE", { stopReason });
    }

    this.cycle = freshCycle();
    return this.transition(ctx, "MAP");
  }
}
