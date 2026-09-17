import { CriticBudgetExhaustedError, type BudgetTracker } from "../budget.js";
import type { AppConfig } from "../config.js";
import { selectConsoleEvidence, selectNetworkEvidence } from "./evidence-scope.js";
import { writeCriticArtifact } from "../evidence.js";
import type { Logger } from "../logger.js";
import { normalizePathname } from "../mapping/state-signature.js";
import { CriticUnavailableError, type CriticProvider } from "../models/critic-provider.js";
import type { ConsoleRecord, CriticInput, EvidenceCompleteness, Finding, NetworkRecord, PageErrorRecord, RequirementRule } from "../types.js";
import type { ValidationOutcome } from "../validator.js";
import { scopeRequirements } from "../requirements.js";
import { checkClaims, firstContradiction } from "./claim-checks.js";
import { decideDisposition, type CriticOutcome } from "./disposition.js";

const NETWORK_EVIDENCE_LIMIT = 20;
const CONSOLE_EVIDENCE_LIMIT = 20;

/** The subset of ValidationOutcome["representativeEvidence"] a CriticInput needs -- also exactly what a finding's persisted evidence files (console.json/network.json/page-errors.json/visible-text.json) reconstruct post-hoc, without re-running the browser (see src/phase2-experiment.ts Condition B). */
export type CriticEvidenceBundle = {
  consoleMessages: ConsoleRecord[];
  networkRequests: NetworkRecord[];
  pageErrors: PageErrorRecord[];
  visibleTextExcerpt: string;
  screenshotPath?: string;
  tracePath?: string;
};

export type CriticAttemptScope = { representativeAttempt: number; totalAttempts: number; completeness: EvidenceCompleteness };

/**
 * Pure mapping from a finding + its evidence to the exact shape a
 * CriticProvider receives -- shared by the live per-run Critic (below) and
 * the Phase-2 experiment harness's post-hoc Condition B reconstruction, so
 * there is exactly one place this mapping is implemented.
 */
export function buildCriticInput(
  finding: Finding,
  evidence: CriticEvidenceBundle,
  requirements: RequirementRule[],
  environment: { targetEnvironment: string; browser: string },
  attemptScope: CriticAttemptScope
): CriticInput {
  const scoped = requirements.length > 0 ? scopeRequirements(requirements, finding.pathname) : [];
  const console = selectConsoleEvidence(evidence.consoleMessages, finding.oracle, CONSOLE_EVIDENCE_LIMIT);
  const network = selectNetworkEvidence(evidence.networkRequests, finding.oracle, NETWORK_EVIDENCE_LIMIT);

  return {
    finding: {
      title: finding.title,
      category: finding.category,
      pathname: finding.pathname,
      expected: finding.expected,
      actual: finding.actual,
      ...(finding.controlKey ? { controlKey: finding.controlKey } : {}),
    },
    evidenceLevel: finding.evidenceLevel,
    ...(scoped.length > 0 ? { requirementContext: scoped } : {}),
    reproduction: finding.reproduction,
    oracle: finding.oracle,
    evidence: {
      console: console.selected.map((m) => ({ type: m.type, text: m.text })),
      consoleScope: { totalCaptured: console.totalCaptured, included: console.selected.length, omitted: console.omitted },
      network: network.selected.map((n) => ({
        method: n.method,
        pathname: normalizePathname(n.url),
        ...(n.status !== undefined ? { status: n.status } : {}),
      })),
      networkScope: {
        totalPageRequests: network.totalPageRequests,
        matchedForTriggeringEndpoint: network.matchedForTriggeringEndpoint,
        included: network.selected.length,
        omitted: network.omitted,
      },
      pageErrors: evidence.pageErrors.map((e) => ({ message: e.message })),
      screenshotPaths: evidence.screenshotPath ? [evidence.screenshotPath] : [],
      traceAvailable: Boolean(evidence.tracePath),
      ...(evidence.visibleTextExcerpt ? { uiTextExcerpt: evidence.visibleTextExcerpt } : {}),
      attemptScope,
    },
    environment: {
      targetEnvironment: environment.targetEnvironment,
      browser: environment.browser,
      pathname: finding.pathname,
    },
  };
}

// Usage accounting (Phase 4 continuation) happens inside the provider's own
// complete() boundary, wired at construction time (see
// run-pipeline.ts#selectCriticProvider) -- CriticDeps deliberately carries
// no usageTracker field, since Critic itself never needs to read one.
export type CriticDeps = {
  criticProvider: CriticProvider | null;
  config: AppConfig;
  logger: Logger;
  requirements: RequirementRule[];
  budget: BudgetTracker;
  /** This run's transient, non-env credential values -- scrubbed from the persisted critic.json artifact (Phase 4 continuation secret-hygiene fix). */
  extraSecrets?: string[];
  /** UI-driven stop (Phase 4 continuation cancellation fix) -- combined with the per-call timeout into the signal actually passed to the provider's SDK request (see deriveTimeoutSignal). Absent for a CLI run (never aborts). */
  abortSignal?: AbortSignal;
};

/**
 * Exported so src/experiments/conditions.ts shares the exact same timeout
 * mechanism -- not a second, independently-reimplemented one.
 *
 * `Promise.race` alone (the original implementation) never aborts the
 * losing promise -- a "timed out" provider call kept running to
 * completion in the background regardless, still consuming a real network
 * request and eventually resolving/rejecting into nothing. Pair this with
 * deriveTimeoutSignal() below: the SAME `ms` deadline drives both this
 * race (which produces the CriticUnavailableError) and an AbortSignal
 * passed into the provider's own SDK call, so the underlying HTTP request
 * is genuinely cancelled at (approximately) the same moment this promise
 * rejects, not merely abandoned.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CriticUnavailableError(`Critic call exceeded providerTimeoutMs (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Builds the AbortSignal actually passed into a provider's SDK call:
 * fires on the same `ms` deadline withTimeout() races against, AND on the
 * run's own abortSignal (a user-initiated Stop) when supplied -- whichever
 * comes first. This is what makes a timeout or a Stop abort the real
 * in-flight HTTP request, not just the logical await in this process.
 */
export function deriveTimeoutSignal(ms: number, external?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(ms);
  return external ? AbortSignal.any([timeoutSignal, external]) : timeoutSignal;
}

/**
 * Validator asks "can this reproduce?"; Critic asks "even though it
 * reproduces, is it actually a product defect?" -- a deliberately separate
 * concept and a deliberately separate class. Reads finding.status/
 * evidenceLevel (already set by the caller before validation/critique run)
 * rather than recomputing them, and never decides reproduction itself.
 */
export class Critic {
  constructor(private readonly deps: CriticDeps) {}

  async review(finding: Finding, validation: ValidationOutcome, evidenceDir: string): Promise<{ finding: Finding }> {
    if (finding.status !== "validated") {
      const { reportDisposition } = decideDisposition({
        validationStatus: finding.status,
        evidenceLevel: finding.evidenceLevel,
        criticOutcome: { kind: "skipped" },
      });
      return { finding: { ...finding, reportDisposition } };
    }

    const { criticProvider, config, logger, requirements, budget, extraSecrets, abortSignal } = this.deps;
    const criticEnabled = config.models.critic.enabled && criticProvider !== null;

    let outcome: CriticOutcome;
    if (!criticEnabled) {
      outcome = { kind: "disabled" };
    } else if (abortSignal?.aborted) {
      logger.info({ findingId: finding.id }, "CANCELLED: skipping critic call (Stop requested)");
      outcome = { kind: "unavailable", reason: "CANCELLED: run was stopped before this critic call started" };
    } else if (!budget.canCallCritic() || budget.isDurationExceeded()) {
      logger.warn(
        { findingId: finding.id },
        "BUDGET_EXHAUSTED: skipping critic call (maxCriticCalls or maxDurationMs)"
      );
      outcome = { kind: "unavailable", reason: "BUDGET_EXHAUSTED: maxCriticCalls or maxDurationMs" };
    } else {
      const input = buildCriticInput(
        finding,
        validation.representativeEvidence,
        requirements,
        { targetEnvironment: config.target.environment, browser: config.browser.engine },
        {
          representativeAttempt: validation.representativeAttempt,
          totalAttempts: validation.attempts.length,
          completeness: validation.evidenceCompleteness,
        }
      );
      // §4 fix (2026-09-14 addendum): a real critic provider now
      // checks/records each of its own real HTTP requests at its own
      // complete() boundary (see anthropic-critic-provider.ts/
      // explabs-critic-provider.ts), so recording unconditionally here
      // would double-count -- and would never catch a first-attempt-then-
      // repair decision that internally makes 2 real requests. Diff-based
      // fallback below: only record here when the provider consumed
      // nothing itself (MockCriticProvider, which makes no real request at
      // all -- preserving the existing "one critic call per review"
      // semantics for mock-driven runs/tests).
      const criticCallsBefore = budget.criticCalls;
      try {
        // Usage accounting (Phase 4 continuation) now happens inside the
        // provider's own complete() boundary, not here -- see
        // provider-implementation.ts/anthropic-critic-provider.ts. The
        // signal passed to critique() ties the timeout AND a
        // user-initiated Stop to the actual in-flight SDK request.
        // 2026-09-15 fix: the request deadline is the LESSER of the
        // provider's own configured timeout and the run's remaining
        // duration budget (see the identical fix in orchestrator.ts#explore()).
        const requestDeadlineMs = Math.min(config.models.providerTimeoutMs, budget.remainingDurationMs());
        const signal = deriveTimeoutSignal(requestDeadlineMs, abortSignal);
        const decision = await withTimeout(criticProvider.critique(input, signal), requestDeadlineMs);
        const contradiction = firstContradiction(checkClaims(decision, input));
        if (contradiction) {
          const reason = `CRITIC_EVIDENCE_CONTRADICTION: ${contradiction.claim} -- ${contradiction.detail}`;
          logger.warn({ findingId: finding.id, reason }, "CRITIC_EVIDENCE_CONTRADICTION");
          outcome = { kind: "contradiction", reason };
        } else {
          outcome = { kind: "decided", decision };
          writeCriticArtifact(
            evidenceDir,
            {
              provider: criticProvider.name,
              ...(criticProvider.modelId ? { model: criticProvider.modelId } : {}),
              ...decision,
            },
            extraSecrets
          );
        }
      } catch (error) {
        if (error instanceof CriticBudgetExhaustedError) {
          logger.warn({ findingId: finding.id, error: error.message }, "BUDGET_EXHAUSTED: critic call refused mid-decision");
          outcome = { kind: "unavailable", reason: `BUDGET_EXHAUSTED: ${error.message}` };
        } else {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn({ findingId: finding.id, error: message }, "CRITIC_MODEL_ERROR: critic call failed or timed out");
          outcome = { kind: "unavailable", reason: `CRITIC_MODEL_ERROR: ${message}` };
        }
      }
      if (budget.criticCalls === criticCallsBefore) {
        budget.recordCriticCall();
      }
    }

    const { reportDisposition, criticEvidenceConflict } = decideDisposition({
      validationStatus: finding.status,
      evidenceLevel: finding.evidenceLevel,
      criticOutcome: outcome,
    });

    const critic = this.buildCriticField(outcome, criticProvider, criticEvidenceConflict);

    return { finding: { ...finding, reportDisposition, ...(critic ? { critic } : {}) } };
  }

  private buildCriticField(
    outcome: CriticOutcome,
    criticProvider: CriticProvider | null,
    conflict: boolean
  ): Finding["critic"] | undefined {
    if (outcome.kind === "decided") {
      return {
        verdict: outcome.decision.verdict,
        confidence: outcome.decision.confidence,
        summary: outcome.decision.summary,
        provider: criticProvider?.name ?? "unknown",
        ...(criticProvider?.modelId ? { model: criticProvider.modelId } : {}),
        ...(conflict ? { criticEvidenceConflict: true } : {}),
        ...(outcome.decision.requirementConflict ? { requirementConflict: outcome.decision.requirementConflict } : {}),
      };
    }
    if (outcome.kind === "unavailable" || outcome.kind === "contradiction") {
      return {
        verdict: "needs_human",
        confidence: 0,
        summary: outcome.reason,
        provider: criticProvider?.name ?? "none",
        ...(conflict ? { criticEvidenceConflict: true } : {}),
      };
    }
    return undefined; // "disabled" -> no critic field at all, matching Condition-A / pre-Phase-2 finding.json shape
  }
}
