import "dotenv/config";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BrowserLaunchError } from "./browser/browser.js";
import { ConfigError, loadConfig, resolveHeadless, type AppConfig } from "./config.js";
import { ensureDir } from "./evidence.js";
import { createLogger } from "./logger.js";
import { LiveModeNotAuthorizedError } from "./models/live-gate.js";
import { generateRunId } from "./report.js";
import { isMainModule } from "./main-module-guard.js";
import { loadGroundTruth, matchFindings } from "./reporting/benchmark.js";
import { runPipeline } from "./run-pipeline.js";

function parseArgs(argv: string[]): { configPath: string } {
  const flagIndex = argv.indexOf("--config");
  const raw = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  return { configPath: resolve(raw ?? "qa.config.yaml") };
}

/**
 * Runs the exact same pipeline as `npm run qa`, then scores the resulting
 * VALIDATED findings against fixture/ground-truth.json. Refuses to run
 * against anything but the local fixture — the ground-truth file only has
 * meaning there, and running it elsewhere would silently produce a
 * meaningless (or misleading) score. Ground truth is loaded here, in
 * evaluation code, after the run completes; it is never passed into the
 * pipeline/Explorer.
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
      'AutoQA benchmark error\n\nnpm run benchmark only operates on the local fixture (target.environment must be "local-fixture").\n' +
        `Configured environment: "${config.target.environment}"`
    );
    process.exitCode = 1;
    return;
  }

  const startedAt = new Date();
  const runId = generateRunId(startedAt);
  const runDir = resolve("runs", runId);
  ensureDir(runDir);

  const logger = createLogger(join(runDir, "run.log"));
  const { headless, reason: headlessReason } = resolveHeadless(config);

  console.log("AutoQA Phase 1 — Benchmark\n");
  console.log(`Run: ${runId}`);
  console.log(`Target: ${config.target.url}`);
  console.log(`Headless: ${headless ? "ON" : "OFF"} — ${headlessReason}\n`);
  console.log("✓ Configuration loaded");

  let result;
  try {
    result = await runPipeline({
      config,
      runId,
      runDir,
      logger,
      headless,
      onProgress: (event) => console.log(event.detail),
      requireLiveAuthorization: { argv: process.argv },
    });
  } catch (error) {
    if (error instanceof ConfigError || error instanceof BrowserLaunchError || error instanceof LiveModeNotAuthorizedError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const { finalCtx } = result;
  const validatedFindings = finalCtx.findings.filter((f) => f.status === "validated");

  const groundTruth = loadGroundTruth(resolve("fixture", "ground-truth.json"));
  const benchmark = matchFindings(validatedFindings, groundTruth.defects);

  writeFileSync(join(runDir, "benchmark.json"), JSON.stringify(benchmark, null, 2), "utf-8");

  console.log("\n=================================================");
  console.log("AutoQA Benchmark Result");
  console.log("=================================================\n");
  console.log(`Matched on:\n${benchmark.matchedOn}\n`);
  console.log(`Seeded defects:\n${benchmark.seededDefects}\n`);
  console.log(`Validated findings reported:\n${benchmark.reportedValidatedFindings}\n`);
  console.log(`True positives:\n${benchmark.truePositives.length}\n`);
  console.log(`False positives:\n${benchmark.falsePositives.length}\n`);
  console.log(`False negatives (missed):\n${benchmark.falseNegatives.length}${benchmark.falseNegatives.length ? " (" + benchmark.falseNegatives.join(", ") + ")" : ""}\n`);
  console.log(`Precision:\n${benchmark.precision.toFixed(3)}\n`);
  console.log(`Recall:\n${benchmark.recall.toFixed(3)}\n`);
  console.log(`F1:\n${benchmark.f1.toFixed(3)}\n`);
  console.log(`Artifacts:\nruns/${runId}`);
  console.log("=================================================");
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("AutoQA benchmark encountered an unexpected error:");
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
