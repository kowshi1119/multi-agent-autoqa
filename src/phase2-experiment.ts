import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BrowserLaunchError } from "./browser/browser.js";
import { ConfigError, loadConfig, resolveHeadless, type AppConfig } from "./config.js";
import { buildCriticInput } from "./critic/critic-runner.js";
import { decideDisposition } from "./critic/disposition.js";
import { MockCriticProvider } from "./critic/mock-critic-provider.js";
import { readAttemptScope, readEvidenceBundle } from "./experiments/evidence-reconstruction.js";
import { ensureDir } from "./evidence.js";
import { createLogger } from "./logger.js";
import { generateRunId, writeFindingJson } from "./report.js";
import { loadGroundTruth, matchFindings, type BenchmarkResult } from "./reporting/benchmark.js";
import { computePhase2Metrics, type Phase2Metrics } from "./reporting/phase2-metrics.js";
import { isMainModule } from "./main-module-guard.js";
import { runPipeline } from "./run-pipeline.js";
import type { Finding, RequirementRule } from "./types.js";

function parseArgs(argv: string[]): { configPath: string } {
  const flagIndex = argv.indexOf("--config");
  const raw = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  return { configPath: resolve(raw ?? "qa.config.yaml") };
}

/** Re-exported for backward compatibility -- moved to src/experiments/evidence-reconstruction.ts (Phase 3) so both this harness and src/experiments/conditions.ts share one implementation. */
export { readEvidenceBundle };

type ConditionResult = {
  findings: Finding[];
  benchmark: BenchmarkResult;
};

/**
 * Condition B re-dispositions each of Condition A's VALIDATED findings
 * using a deterministic critic, entirely in-process from already-recorded
 * evidence -- it never re-runs the browser or re-explores the app. This is
 * what makes the comparison fair (detection is held constant; only the
 * critic layer varies) and cheap (one browser run backs both conditions).
 */
export async function runConditionB(
  conditionAFindings: Finding[],
  conditionARunDir: string,
  config: AppConfig,
  requirements: RequirementRule[],
  outDir: string
): Promise<ConditionResult> {
  const critic = new MockCriticProvider();
  const findings: Finding[] = [];

  for (const finding of conditionAFindings) {
    if (finding.status !== "validated") {
      findings.push(finding);
      continue;
    }

    const evidenceDir = join(conditionARunDir, "findings", finding.id);
    const evidence = readEvidenceBundle(evidenceDir);
    const attemptScope = readAttemptScope(evidenceDir);
    const input = buildCriticInput(
      finding,
      evidence,
      requirements,
      { targetEnvironment: config.target.environment, browser: config.browser.engine },
      attemptScope
    );

    const decision = await critic.critique(input);
    const { reportDisposition, criticEvidenceConflict } = decideDisposition({
      validationStatus: finding.status,
      evidenceLevel: finding.evidenceLevel,
      criticOutcome: { kind: "decided", decision },
    });
    const critiqued: Finding = {
      ...finding,
      reportDisposition,
      critic: {
        verdict: decision.verdict,
        confidence: decision.confidence,
        summary: decision.summary,
        provider: critic.name,
        ...(criticEvidenceConflict ? { criticEvidenceConflict: true } : {}),
        ...(decision.requirementConflict ? { requirementConflict: decision.requirementConflict } : {}),
      },
    };

    const findingOutDir = join(outDir, "findings", finding.id);
    ensureDir(findingOutDir);
    writeFindingJson(findingOutDir, critiqued);
    findings.push(critiqued);
  }

  const groundTruth = loadGroundTruth(resolve("fixture", "ground-truth.json")).defects;
  const benchmark = matchFindings(
    findings.filter((f) => f.reportDisposition === "report"),
    groundTruth
  );
  return { findings, benchmark };
}

export type Phase2ExperimentResult = {
  conditionA: { runId: string; runDir: string; benchmark: BenchmarkResult };
  conditionB: { runDir: string; benchmark: BenchmarkResult };
  conditionC: null;
  conditionCNote: string;
  metrics: Phase2Metrics;
};

/**
 * Runs the false-positive-challenge experiment: one real browser pass
 * against the local fixture (Condition A, critic disabled -- Phase-1
 * detection semantics), then a post-hoc, in-process re-disposition of the
 * same findings with the critic enabled (Condition B). Condition C
 * (cross-provider Explorer/Critic pairing) needs a second live-provider
 * Explorer, unavailable in this environment -- reported as an honest
 * `null`, never fabricated.
 */
async function main(): Promise<void> {
  const { configPath } = parseArgs(process.argv.slice(2));

  let config: AppConfig;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (config.target.environment !== "local-fixture") {
    console.error(
      'AutoQA experiment error\n\nnpm run experiment:phase2 only operates on the local fixture (target.environment must be "local-fixture").\n' +
        `Configured environment: "${config.target.environment}"`
    );
    process.exitCode = 1;
    return;
  }

  const startedAt = new Date();
  const experimentId = `EXPERIMENT-${generateRunId(startedAt).replace(/^RUN-/, "")}`;
  const experimentDir = resolve("runs", "experiments", experimentId);
  mkdirSync(experimentDir, { recursive: true });

  const conditionARunId = generateRunId(startedAt);
  const conditionARunDir = resolve("runs", conditionARunId);
  ensureDir(conditionARunDir);

  const logger = createLogger(join(conditionARunDir, "run.log"));
  const { headless, reason: headlessReason } = resolveHeadless(config);

  console.log("AutoQA Phase 2 — False-Positive-Challenge Experiment\n");
  console.log(`Experiment: ${experimentId}`);
  console.log(`Condition A run: ${conditionARunId}`);
  console.log(`Headless: ${headless ? "ON" : "OFF"} — ${headlessReason}\n`);

  // Condition A: critic forced off, regardless of the loaded config, so
  // this always reproduces Phase-1 detection-only semantics as the
  // baseline every comparison is measured against.
  const conditionAConfig: AppConfig = {
    ...config,
    models: { ...config.models, critic: { ...config.models.critic, enabled: false } },
  };

  let result;
  try {
    result = await runPipeline({
      config: conditionAConfig,
      runId: conditionARunId,
      runDir: conditionARunDir,
      logger,
      headless,
      onProgress: (message) => console.log(message),
    });
  } catch (error) {
    if (error instanceof ConfigError || error instanceof BrowserLaunchError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const conditionAFindings = result.finalCtx.findings;
  const groundTruth = loadGroundTruth(resolve("fixture", "ground-truth.json")).defects;
  const conditionABenchmark = matchFindings(
    conditionAFindings.filter((f) => f.status === "validated"),
    groundTruth
  );

  console.log(
    `\nCondition A (detection only): precision ${conditionABenchmark.precision.toFixed(3)} / recall ${conditionABenchmark.recall.toFixed(3)} / F1 ${conditionABenchmark.f1.toFixed(3)}`
  );

  const conditionBDir = join(experimentDir, "condition-b");
  ensureDir(conditionBDir);
  const conditionB = await runConditionB(conditionAFindings, conditionARunDir, config, result.requirements, conditionBDir);

  console.log(
    `Condition B (critic-suppressed):    precision ${conditionB.benchmark.precision.toFixed(3)} / recall ${conditionB.benchmark.recall.toFixed(3)} / F1 ${conditionB.benchmark.f1.toFixed(3)}`
  );

  const metrics = computePhase2Metrics(conditionABenchmark, conditionB.benchmark);
  console.log(
    `\nFalse positives suppressed: ${metrics.falsePositivesSuppressed} (${(metrics.falsePositiveReductionRate * 100).toFixed(1)}%)`
  );
  console.log(`Recall lost to suppression: ${(metrics.recallLoss * 100).toFixed(1)}%`);

  const conditionCNote =
    "SKIPPED — Condition C (a second, independently-hosted Explorer+Critic provider pairing) requires a live cross-provider credential not available in this environment. Never fabricated.";
  console.log(`\nCondition C: ${conditionCNote}`);

  const experimentResult: Phase2ExperimentResult = {
    conditionA: { runId: conditionARunId, runDir: conditionARunDir, benchmark: conditionABenchmark },
    conditionB: { runDir: conditionBDir, benchmark: conditionB.benchmark },
    conditionC: null,
    conditionCNote,
    metrics,
  };
  writeFileSync(join(experimentDir, "phase2-experiment.json"), JSON.stringify(experimentResult, null, 2), "utf-8");

  console.log(`\nArtifacts:\nruns/experiments/${experimentId}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("AutoQA Phase 2 experiment encountered an unexpected error:");
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
