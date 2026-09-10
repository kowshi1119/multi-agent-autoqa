import { join } from "node:path";
import { buildCriticInput } from "../critic/critic-runner.js";
import { checkClaims, firstContradiction } from "../critic/claim-checks.js";
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

  const criticProvider = criticOn ? selectCriticProvider(conditionConfig, logger) : null;
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
    try {
      const decision = await criticProvider.critique(input);
      const contradiction = firstContradiction(checkClaims(decision, input));
      outcome = contradiction
        ? { kind: "contradiction", reason: `CRITIC_EVIDENCE_CONTRADICTION: ${contradiction.claim} -- ${contradiction.detail}` }
        : { kind: "decided", decision };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { kind: "unavailable", reason: `CRITIC_MODEL_ERROR: ${message}` };
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
