import { join } from "node:path";
import { buildCriticInput, deriveTimeoutSignal, withTimeout } from "../critic/critic-runner.js";
import { checkClaims, firstContradiction } from "../critic/claim-checks.js";
import { BudgetTracker, CriticBudgetExhaustedError } from "../budget.js";
import type { AppConfig } from "../config.js";
import { decideDisposition, type CriticOutcome } from "../critic/disposition.js";
import { groupFindings } from "../grouping/group-findings.js";
import type { GroupingResult } from "../grouping/types.js";
import type { Logger } from "../logger.js";
import { matchFindings, type BenchmarkResult, type GroundTruthDefect } from "../reporting/benchmark.js";
import { selectCriticProvider } from "../run-pipeline.js";
import type { Finding, RequirementRule } from "../types.js";
import { readAttemptScope, readEvidenceBundle } from "./evidence-reconstruction.js";

/**
 * Descriptive condition ids (never "A/B/C" -- Phase 2 already uses that
 * naming for its own, differently-scoped conditions). Only ever
 * referenced as a legacy label inside comparison tables, never as a live
 * schema/code identifier.
 */
export type Phase3ConditionId =
  | "critic_off_grouping_off"
  | "critic_on_grouping_off"
  | "critic_off_grouping_on"
  | "critic_on_grouping_on";

export const PHASE3_CONDITION_IDS: readonly Phase3ConditionId[] = [
  "critic_off_grouping_off",
  "critic_on_grouping_off",
  "critic_off_grouping_on",
  "critic_on_grouping_on",
] as const;

/** Comparison-table-only cross-reference to Phase 2's existing Condition A (critic off) / Condition B (critic on) naming -- never used as a live identifier anywhere in Phase 3 schemas or code. */
export const LEGACY_PHASE2_LABEL: Record<Phase3ConditionId, string | null> = {
  critic_off_grouping_off: "Phase 2 Condition A (critic off)",
  critic_on_grouping_off: "Phase 2 Condition B (critic on)",
  critic_off_grouping_on: null,
  critic_on_grouping_on: null,
};

export type ConditionRunResult = {
  conditionId: Phase3ConditionId;
  findings: Finding[];
  grouping: GroupingResult;
  /** Matched against reportable (reportDisposition==="report"), canonical/ungrouped findings -- comparable across all four conditions by construction. */
  benchmark: BenchmarkResult;
};

/**
 * Runs one condition entirely from already-captured findings + persisted
 * evidence -- never re-opens the browser. Critic on/off is wired through
 * the REAL selectCriticProvider() path (not a hardcoded MockCriticProvider),
 * closing the Phase 2 harness's gap where "Condition C" could never
 * actually execute because the critic provider was hardcoded. Grouping
 * on/off calls the same groupFindings() Milestone B added.
 */
export async function runCondition(
  conditionId: Phase3ConditionId,
  capturedFindings: Finding[],
  runDir: string,
  baseConfig: AppConfig,
  requirements: RequirementRule[],
  logger: Logger,
  groundTruth: GroundTruthDefect[]
): Promise<ConditionRunResult> {
  const criticOn = conditionId.startsWith("critic_on");
  const groupingOn = conditionId.endsWith("grouping_on");

  const conditionConfig: AppConfig = {
    ...baseConfig,
    models: { ...baseConfig.models, critic: { ...baseConfig.models.critic, enabled: criticOn } },
    grouping: { enabled: groupingOn },
  };

  // Same guardrails as the live per-run Critic.review() (src/critic/
  // critic-runner.ts): a bounded request count and a bounded per-call
  // timeout. Sharing buildCriticInput()/decideDisposition() alone does
  // NOT guarantee this -- confirmed as a real, distinct gap: this
  // function used to call criticProvider.critique() directly with no
  // timeout and no request cap, unlike the live path. A fresh budget
  // scoped to this one condition run (mirrors run-pipeline.ts's own
  // BudgetTracker construction from config.agent.*). Constructed BEFORE
  // selectCriticProvider() (§4 fix, 2026-09-14 addendum) so it can be
  // threaded into the real provider's own constructor -- the same
  // check-then-reserve-at-the-real-request-boundary fix as the live path.
  const budget = new BudgetTracker({
    maxActions: conditionConfig.agent.maxActions,
    maxModelCalls: conditionConfig.agent.maxModelCalls,
    maxPages: conditionConfig.agent.maxPages,
    maxFindings: conditionConfig.agent.maxFindings,
    maxDurationMs: conditionConfig.agent.maxDurationMs,
    maxCriticCalls: conditionConfig.agent.maxCriticCalls,
  });
  const criticProvider = criticOn ? selectCriticProvider(conditionConfig, logger, undefined, budget) : null;
  const findings: Finding[] = [];

  for (const finding of capturedFindings) {
    if (finding.status !== "validated") {
      const { reportDisposition } = decideDisposition({
        validationStatus: finding.status,
        evidenceLevel: finding.evidenceLevel,
        criticOutcome: { kind: "skipped" },
      });
      findings.push({ ...finding, reportDisposition });
      continue;
    }

    if (!criticOn || !criticProvider) {
      const { reportDisposition } = decideDisposition({
        validationStatus: finding.status,
        evidenceLevel: finding.evidenceLevel,
        criticOutcome: { kind: "disabled" },
      });
      findings.push({ ...finding, reportDisposition });
      continue;
    }

    const evidenceDir = join(runDir, "findings", finding.id);
    const evidence = readEvidenceBundle(evidenceDir);
    const attemptScope = readAttemptScope(evidenceDir);
    const input = buildCriticInput(
      finding,
      evidence,
      requirements,
      { targetEnvironment: conditionConfig.target.environment, browser: conditionConfig.browser.engine },
      attemptScope
    );

    let outcome: CriticOutcome;
    if (!budget.canCallCritic() || budget.isDurationExceeded()) {
      logger.warn({ findingId: finding.id, conditionId }, "BUDGET_EXHAUSTED: skipping critic call (maxCriticCalls or maxDurationMs)");
      outcome = { kind: "unavailable", reason: "BUDGET_EXHAUSTED: maxCriticCalls or maxDurationMs" };
    } else {
      // §4 fix (2026-09-14 addendum): diff-based fallback, mirroring
      // critic-runner.ts#review() -- a real provider now records its own
      // real HTTP requests at its own complete() boundary, so recording
      // unconditionally here would double-count; only fall back to
      // recording here when the provider consumed nothing itself
      // (MockCriticProvider).
      const criticCallsBefore = budget.criticCalls;
      try {
        // 2026-09-15 fix: this used to call critique() with no signal at
        // all, unlike the live Critic.review() path -- withTimeout()'s own
        // race meant the CALLER gave up waiting on timeout, but a real
        // provider's underlying HTTP request was never actually aborted
        // (abandoned in the background, the exact anti-pattern withTimeout()
        // itself exists to avoid -- see its own doc comment). Mirrors the
        // live path exactly, including shrinking the deadline to the
        // remaining run-duration budget.
        const requestDeadlineMs = Math.min(conditionConfig.models.providerTimeoutMs, budget.remainingDurationMs());
        const signal = deriveTimeoutSignal(requestDeadlineMs);
        const decision = await withTimeout(criticProvider.critique(input, signal), requestDeadlineMs);
        const contradiction = firstContradiction(checkClaims(decision, input));
        outcome = contradiction
          ? { kind: "contradiction", reason: `CRITIC_EVIDENCE_CONTRADICTION: ${contradiction.claim} -- ${contradiction.detail}` }
          : { kind: "decided", decision };
      } catch (error) {
        if (error instanceof CriticBudgetExhaustedError) {
          outcome = { kind: "unavailable", reason: `BUDGET_EXHAUSTED: ${error.message}` };
        } else {
          const message = error instanceof Error ? error.message : String(error);
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

    const critic: Finding["critic"] =
      outcome.kind === "decided"
        ? {
            verdict: outcome.decision.verdict,
            confidence: outcome.decision.confidence,
            summary: outcome.decision.summary,
            provider: criticProvider.name,
            ...(criticProvider.modelId ? { model: criticProvider.modelId } : {}),
            ...(criticEvidenceConflict ? { criticEvidenceConflict: true } : {}),
            ...(outcome.decision.requirementConflict ? { requirementConflict: outcome.decision.requirementConflict } : {}),
          }
        : {
            verdict: "needs_human",
            confidence: 0,
            summary: outcome.reason,
            provider: criticProvider.name,
            ...(criticEvidenceConflict ? { criticEvidenceConflict: true } : {}),
          };

    findings.push({ ...finding, reportDisposition, critic });
  }

  const grouping = groupFindings(findings, { enabled: groupingOn });
  const canonicalIds = new Set(grouping.groups.map((g) => g.canonicalFindingId));
  const reportable = findings.filter(
    (f) => (grouping.ungrouped.includes(f.id) || canonicalIds.has(f.id)) && f.reportDisposition === "report"
  );
  const benchmark = matchFindings(reportable, groundTruth);

  return { conditionId, findings, grouping, benchmark };
}
