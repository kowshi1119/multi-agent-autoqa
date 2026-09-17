import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../logger.js";
import { assertLiveModeAuthorized } from "../models/live-gate.js";
import type { GroundTruthDefect } from "../reporting/benchmark.js";
import type { Finding, RequirementRule } from "../types.js";
import { PHASE3_CONDITION_IDS, runCondition, type ConditionRunResult } from "./conditions.js";
import { verifyManifestIntegrity, type ExperimentManifest, type IntegrityCheckResult } from "./manifest.js";

function loadCapturedFindings(manifest: ExperimentManifest): Finding[] {
  return manifest.findingsSnapshot.map((snapshot) => {
    const raw = readFileSync(join(snapshot.evidenceDir, "finding.json"), "utf-8");
    return JSON.parse(raw) as Finding;
  });
}

export type ReplayResult = {
  integrity: IntegrityCheckResult;
  results: ConditionRunResult[];
};

/**
 * Verifies manifest integrity, then re-runs all four conditions purely
 * from persisted evidence -- never reopens the target browser or the
 * fixture server. This is what makes replay "immutable": the same
 * manifest replayed twice produces the same integrity result and (for
 * deterministic providers) the same condition results.
 */
export async function replayExperiment(
  manifest: ExperimentManifest,
  requirements: RequirementRule[],
  logger: Logger,
  groundTruth: GroundTruthDefect[]
): Promise<ReplayResult> {
  // Replaying a manifest whose sanitizedConfig declares a live critic
  // provider is still a real, billed request -- confirmed gap: this path
  // previously had zero live-execution gating at all. Checked against
  // the SAME critic.enabled:true forcing phase3-experiment.ts's capture
  // path uses, since PHASE3_CONDITION_IDS always includes critic_on_*
  // conditions regardless of the manifest's own captured enabled value.
  assertLiveModeAuthorized(
    { models: { explorer: manifest.sanitizedConfig.models.explorer, critic: { ...manifest.sanitizedConfig.models.critic, enabled: true } } },
    process.argv
  );

  const integrity = verifyManifestIntegrity(manifest);
  const capturedFindings = loadCapturedFindings(manifest);
  const runDir = manifest.datasetIdentity.runDir;

  const results: ConditionRunResult[] = [];
  for (const conditionId of PHASE3_CONDITION_IDS) {
    results.push(await runCondition(conditionId, capturedFindings, runDir, manifest.sanitizedConfig, requirements, logger, groundTruth));
  }

  return { integrity, results };
}
