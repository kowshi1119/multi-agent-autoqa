import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BrowserLaunchError } from "./browser/browser.js";
import { ConfigError, loadConfig, resolveHeadless, type AppConfig } from "./config.js";
import { LEGACY_PHASE2_LABEL, PHASE3_CONDITION_IDS, runCondition, type ConditionRunResult } from "./experiments/conditions.js";
import { captureManifest, type ExperimentManifest } from "./experiments/manifest.js";
import { replayExperiment } from "./experiments/replay.js";
import { ensureDir } from "./evidence.js";
import { createLogger } from "./logger.js";
import { isMainModule } from "./main-module-guard.js";
import { redactSecrets } from "./redact.js";
import { generateRunId } from "./report.js";
import { loadGroundTruth } from "./reporting/benchmark.js";
import { loadRequirements } from "./requirements.js";
import { runPipeline } from "./run-pipeline.js";

/** Same defense-in-depth idiom as evidence.ts#writeJson -- applied even though sanitizedConfig/findings are already credential-free by construction. */
function writeJsonRedacted(path: string, data: unknown): void {
  writeFileSync(path, redactSecrets(JSON.stringify(data, null, 2)), "utf-8");
}

function parseArgs(argv: string[]): { subcommand: "capture" | "replay"; configPath: string; manifestPath?: string } {
  const subcommand: "capture" | "replay" = argv[0] === "replay" ? "replay" : "capture";
  const configFlag = argv.indexOf("--config");
  const configPath = resolve(configFlag !== -1 ? (argv[configFlag + 1] as string) : "qa.config.yaml");
  const manifestFlag = argv.indexOf("--manifest");
  const manifestPath = manifestFlag !== -1 ? resolve(argv[manifestFlag + 1] as string) : undefined;
  return { subcommand, configPath, manifestPath };
}

function printConditionResult(result: ConditionRunResult): void {
  const legacy = LEGACY_PHASE2_LABEL[result.conditionId];
  const bm = result.benchmark;
  console.log(
    `${result.conditionId}${legacy ? ` (legacy: ${legacy})` : ""}:\n` +
      `  precision ${bm.precision.toFixed(3)} / recall ${bm.recall.toFixed(3)} / F1 ${bm.f1.toFixed(3)} ` +
      `(${bm.truePositives.length} TP, ${bm.falsePositives.length} FP, ${bm.falseNegatives.length} FN)`
  );
}

/**
 * Offline-first Phase 3 experiment command: `capture` runs the browser
 * once (critic forced off, a neutral baseline) and writes an immutable
 * manifest; `replay --manifest <path>` re-runs all four descriptive-ID
 * conditions purely from persisted evidence, verifying integrity first --
 * neither replay nor the four post-hoc conditions ever reopen the
 * browser or the fixture server.
 */
async function main(): Promise<void> {
  const { subcommand, configPath, manifestPath } = parseArgs(process.argv.slice(2));

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
      'AutoQA Phase 3 experiment error\n\nonly operates on the local fixture (target.environment must be "local-fixture").\n' +
        `Configured environment: "${config.target.environment}"`
    );
    process.exitCode = 1;
    return;
  }

  const requirements = config.requirements.enabled ? loadRequirements(config.requirements.path) : [];
  const groundTruth = loadGroundTruth(resolve("fixture", "ground-truth.json")).defects;
  const logger = createLogger();

  if (subcommand === "replay") {
    if (!manifestPath) {
      console.error("AutoQA Phase 3 experiment error\n\nreplay requires --manifest <path>");
      process.exitCode = 1;
      return;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ExperimentManifest;

    console.log("AutoQA Phase 3 Experiment — Replay\n");
    console.log(`Manifest: ${manifestPath}`);

    const { integrity, results } = await replayExperiment(manifest, requirements, logger, groundTruth);

    console.log(`Integrity: ${integrity.valid ? "VALID -- every evidence file hash matches the manifest" : "MISMATCHES FOUND"}\n`);
    if (!integrity.valid) {
      for (const m of integrity.mismatches) console.log(`  - ${m.findingId}/${m.file}: ${m.reason}`);
      console.log("");
    }
    for (const result of results) printConditionResult(result);
    return;
  }

  // capture
  const startedAt = new Date();
  const runId = generateRunId(startedAt);
  const experimentId = `EXPERIMENT3-${runId.replace(/^RUN-/, "")}`;
  const runDir = resolve("runs", runId);
  ensureDir(runDir);

  const runLogger = createLogger(join(runDir, "run.log"));
  const { headless, reason: headlessReason } = resolveHeadless(config);

  console.log("AutoQA Phase 3 Experiment — Capture\n");
  console.log(`Experiment: ${experimentId}`);
  console.log(`Capture run: ${runId}`);
  console.log(`Headless: ${headless ? "ON" : "OFF"} — ${headlessReason}\n`);

  // Capture always runs with the critic OFF -- a neutral detection-only
  // baseline. The four conditions (critic/grouping on or off) are all
  // computed post-hoc from this one capture, exactly like Phase 2's
  // Condition A/B harness, extended to a 2x2 matrix.
  const captureConfig: AppConfig = {
    ...config,
    models: { ...config.models, critic: { ...config.models.critic, enabled: false } },
  };

  let result;
  try {
    result = await runPipeline({
      config: captureConfig,
      runId,
      runDir,
      logger: runLogger,
      headless,
      onProgress: (event) => console.log(event.detail),
    });
  } catch (error) {
    if (error instanceof ConfigError || error instanceof BrowserLaunchError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const capturedFindings = result.finalCtx.findings;

  const manifest = captureManifest({
    experimentId,
    config,
    runId,
    runDir,
    findingIds: capturedFindings.map((f) => f.id),
    explorerProviderName: result.modelRouter.getExplorer().name,
    ...(config.models.explorer.model ? { explorerModel: config.models.explorer.model } : {}),
  });

  const experimentDir = resolve("runs", "experiments", experimentId);
  ensureDir(experimentDir);
  const manifestPathOut = join(experimentDir, "manifest.json");
  writeJsonRedacted(manifestPathOut, manifest);
  console.log(`\n✓ Manifest captured: runs/experiments/${experimentId}/manifest.json`);

  console.log("\nRunning all four conditions...\n");
  const results: ConditionRunResult[] = [];
  for (const conditionId of PHASE3_CONDITION_IDS) {
    const conditionResult = await runCondition(conditionId, capturedFindings, runDir, config, requirements, logger, groundTruth);
    results.push(conditionResult);
    printConditionResult(conditionResult);
  }

  writeJsonRedacted(join(experimentDir, "conditions.json"), results);

  console.log(`\nArtifacts:\nruns/experiments/${experimentId}`);
  console.log(`\nReplay with:\nnode dist/src/phase3-experiment.js replay --manifest ${manifestPathOut}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("AutoQA Phase 3 experiment encountered an unexpected error:");
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
