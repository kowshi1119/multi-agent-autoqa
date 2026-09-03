import "dotenv/config";
import { join, resolve } from "node:path";
import { executeAction } from "./actions.js";
import { BrowserLaunchError, BrowserManager } from "./browser/browser.js";
import { observe } from "./browser/observation.js";
import { Budget } from "./budget.js";
import { ConfigError, loadConfig, resolveHeadless, type AppConfig } from "./config.js";
import { ensureDir, writeFindingEvidence } from "./evidence.js";
import { Explorer } from "./explorer.js";
import { createLogger, type Logger } from "./logger.js";
import { AnthropicModelProvider, MockModelProvider } from "./models/provider-implementation.js";
import type { ModelProvider } from "./models/provider.js";
import { defaultOracles } from "./oracles.js";
import {
  buildFindingNarrative,
  buildFindingTitle,
  generateFindingId,
  generateRunId,
  writeFindingJson,
  writeRunSummary,
  type RunSummary,
} from "./report.js";
import type { ElementTarget, Finding, Observation, QaAction, RecordedStep } from "./types.js";
import { Validator } from "./validator.js";
import { startFixtureServer, type FixtureServer } from "../fixture/server.js";

function parseArgs(argv: string[]): { configPath: string } {
  const flagIndex = argv.indexOf("--config");
  const raw = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  return { configPath: resolve(raw ?? "qa.config.yaml") };
}

function selectProvider(logger: Logger): ModelProvider {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey) {
    logger.info({ provider: "anthropic" }, "Using AnthropicModelProvider (ANTHROPIC_API_KEY present)");
    return new AnthropicModelProvider(apiKey, logger);
  }
  logger.info(
    { provider: "mock" },
    "No ANTHROPIC_API_KEY found; using deterministic MockModelProvider"
  );
  return new MockModelProvider();
}

function describeTarget(target: ElementTarget): string {
  return target.name ?? target.label ?? target.text ?? target.testId ?? target.role ?? "element";
}

function describeAction(action: QaAction): string {
  switch (action.type) {
    case "click":
      return `Click ${describeTarget(action.target)}`;
    case "fill":
      return `Fill ${describeTarget(action.target)} with "${action.value}"`;
    case "press":
      return `Press "${action.key}"${action.target ? ` on ${describeTarget(action.target)}` : ""}`;
    case "reload":
      return "Reload page";
    case "navigate":
      return `Navigate to ${action.url}`;
    case "wait":
      return `Wait ${action.milliseconds}ms`;
    case "stop":
      return `Stop: ${action.reason}`;
  }
}

function summarizeElements(observation: Observation): string[] {
  const counts = new Map<string, number>();
  for (const el of observation.interactiveElements) {
    if (!el.visible) continue;
    const key = el.role ?? "element";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return ["(no visible interactive elements)"];
  return [...counts.entries()].map(([role, count]) => `${count} ${role}${count === 1 ? "" : "s"}`);
}

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

  const startedAt = new Date();
  const runId = generateRunId(startedAt);
  const runDir = resolve("runs", runId);
  ensureDir(runDir);

  const logger = createLogger(join(runDir, "run.log"));
  const { headless, reason: headlessReason } = resolveHeadless(config);

  console.log("AutoQA Phase 0\n");
  console.log(`Run: ${runId}`);
  console.log(`Target: ${config.target.url}`);
  console.log(`Safe mode: ${config.safety.safeMode ? "ON" : "OFF"}`);
  console.log(`Headless: ${headless ? "ON" : "OFF"} — ${headlessReason}\n`);

  logger.info({ runId, headless, headlessReason, target: config.target.url }, "Run started");
  console.log("✓ Configuration loaded");

  const provider = selectProvider(logger);
  console.log(
    `AI provider: ${provider.name}${
      provider.name === "mock" ? " (no live model credentials found; using deterministic mock)" : ""
    }`
  );

  const browserManager = new BrowserManager(config, logger, headless);
  const budget = new Budget(config.agent.maxActions, config.agent.maxModelCalls);
  const oracles = defaultOracles();
  const recordedSteps: RecordedStep[] = [];
  const findings: Finding[] = [];

  let fixtureServer: FixtureServer | null = null;

  try {
    if (config.target.environment === "local-fixture") {
      const port = Number(new URL(config.target.url).port || "80");
      fixtureServer = await startFixtureServer(port);
      logger.info({ port }, "Local fixture server started");
      console.log("✓ Local fixture server started");
    }

    try {
      await browserManager.launch();
    } catch (error) {
      if (error instanceof BrowserLaunchError) {
        console.error(error.message);
        logger.error({ error: error.message }, "Browser launch failed");
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    console.log("✓ Chromium started");

    const session = await browserManager.newPageSession();
    let sessionOpen = true;

    try {
      try {
        await session.page.goto(config.target.url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `AutoQA could not reach the target: ${config.target.url}\n${message}`
        );
        logger.error({ error: message, url: config.target.url }, "Target navigation failed");
        process.exitCode = 1;
        return;
      }
      console.log(
        config.target.environment === "local-fixture" ? "✓ Local fixture opened" : "✓ Target opened"
      );

      while (true) {
        if (!budget.canCallModel()) {
          console.log("\nBudget exhausted: reached maxModelCalls. Stopping.");
          logger.info({ reason: "max_model_calls_reached" }, "Stopping: model call budget exhausted");
          break;
        }

        const before = await observe(session.page, session.records);
        console.log("\nObservation:");
        for (const line of summarizeElements(before)) console.log(`- ${line}`);

        const explorer = new Explorer(provider, logger);
        const remainingActions = config.agent.maxActions - budget.actionsPerformed;
        const outcome = await explorer.decide({
          observation: before,
          previousActions: recordedSteps,
          remainingActions,
        });
        budget.recordModelCall();

        if (outcome.kind === "stop") {
          const reasonText =
            outcome.stopReason.type === "model_requested_stop"
              ? outcome.stopReason.reason
              : "Model output was invalid after one repair attempt (MODEL_OUTPUT_INVALID).";
          console.log(`\nExplorer:\n${reasonText}`);
          break;
        }

        if (!budget.canAct()) {
          console.log("\nBudget exhausted: reached maxActions. Stopping.");
          logger.info({ reason: "max_actions_reached" }, "Stopping: action budget exhausted");
          break;
        }

        const decision = outcome.decision;
        console.log(`\nExplorer:\n${decision.testingIntent}\n`);
        console.log(`→ ${describeAction(decision.action)}`);

        const execResult = await executeAction(session.page, decision.action, config, logger);
        budget.recordAction();

        const step: RecordedStep = {
          number: budget.actionsPerformed,
          action: decision.action,
          testingIntent: decision.testingIntent,
          timestamp: new Date().toISOString(),
        };
        recordedSteps.push(step);

        if (execResult.outcome !== "success") {
          console.log(`\n${execResult.reason}`);
          logger.warn({ step, outcome: execResult }, "Action did not complete successfully");
          continue;
        }

        const after = await observe(session.page, session.records);

        let suspicious = null;
        for (const oracle of oracles) {
          const result = await oracle.evaluate(before, step, after);
          if (result.suspicious) {
            suspicious = result;
            break;
          }
        }

        if (!suspicious) continue;

        console.log(`\nOracle:\n${suspicious.actual}\n`);
        console.log("Potential finding created.");
        logger.info({ oracleResult: suspicious }, "Suspicious result detected");

        await browserManager.closeSession(session);
        sessionOpen = false;

        const findingId = generateFindingId(findings.length + 1);
        const evidenceDir = join(runDir, "findings", findingId);
        ensureDir(evidenceDir);

        const narrative = buildFindingNarrative(suspicious.oracleId, {
          expected: suspicious.expected,
          actual: suspicious.actual,
        });
        const suspectedFinding: Finding = {
          id: findingId,
          title: buildFindingTitle(suspicious.oracleId),
          status: "suspected",
          url: after.url,
          expected: narrative.expected,
          actual: narrative.actual,
          oracle: suspicious,
          steps: [...recordedSteps],
          reproduction: { attempts: 0, successes: 0 },
          evidence: [],
        };

        console.log("\nValidator:\n");
        const validator = new Validator({ browserManager, config, oracles, logger, evidenceDir });
        const validation = await validator.validate(suspectedFinding);

        for (const attempt of validation.attempts) {
          console.log(
            `Attempt ${attempt.attempt}/${config.validation.attempts}: ${
              attempt.reproduced ? "reproduced" : "not reproduced"
            }`
          );
        }

        const evidenceResult = writeFindingEvidence(evidenceDir, config, {
          oracle: suspectedFinding.oracle,
          attempts: validation.attempts,
          reproduction: validation.finding.reproduction,
          consoleMessages: validation.representativeEvidence.consoleMessages,
          networkRequests: validation.representativeEvidence.networkRequests,
          ...(validation.representativeEvidence.screenshotPath
            ? { screenshotPath: validation.representativeEvidence.screenshotPath }
            : {}),
          ...(validation.representativeEvidence.tracePath
            ? { tracePath: validation.representativeEvidence.tracePath }
            : {}),
        });

        const finalizedFinding: Finding = {
          ...validation.finding,
          evidence: evidenceResult.filenames,
        };
        writeFindingJson(evidenceDir, finalizedFinding);
        findings.push(finalizedFinding);

        console.log(`\nFinding ${finalizedFinding.status.toUpperCase()}.`);
        if (evidenceResult.skipped.length > 0) {
          console.log(`Evidence skipped: ${evidenceResult.skipped.join(", ")}`);
        }
        console.log(`\nEvidence:\n${evidenceDir}`);

        break;
      }
    } finally {
      if (sessionOpen) {
        await browserManager.closeSession(session);
      }
    }
  } finally {
    await browserManager.close();
    if (fixtureServer) {
      await fixtureServer.close();
      logger.info({}, "Local fixture server stopped");
    }
  }

  const finishedAt = new Date();
  const summary: RunSummary = {
    runId,
    project: config.project.name,
    target: config.target.url,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status: "completed",
    provider: provider.name,
    actionsPerformed: budget.actionsPerformed,
    modelCalls: budget.modelCalls,
    suspectedFindings: findings.length,
    validatedFindings: findings.filter((f) => f.status === "validated").length,
    rejectedFindings: findings.filter((f) => f.status === "rejected").length,
    needsHuman: findings.filter((f) => f.status === "needs_human").length,
    tokenUsage: null,
  };
  writeRunSummary(runDir, summary);
  logger.info({ summary }, "Run complete");

  console.log("\n⚙ Run complete.");
  console.log("\n=================================================");
  console.log("AutoQA Phase-0 Run Complete");
  console.log("=================================================\n");
  console.log(`Run ID:\n${summary.runId}\n`);
  console.log(`Target:\n${summary.target}\n`);
  console.log(`Provider:\n${summary.provider}\n`);
  console.log(`Actions:\n${summary.actionsPerformed}\n`);
  console.log(`Model calls:\n${summary.modelCalls}\n`);
  console.log(`Findings suspected:\n${summary.suspectedFindings}\n`);
  console.log(`Validated:\n${summary.validatedFindings}\n`);
  console.log(`Rejected:\n${summary.rejectedFindings}\n`);
  console.log(`Needs human:\n${summary.needsHuman}\n`);
  console.log(`Artifacts:\nruns/${summary.runId}`);
  console.log("=================================================");
}

main().catch((error: unknown) => {
  console.error("AutoQA encountered an unexpected error:");
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
