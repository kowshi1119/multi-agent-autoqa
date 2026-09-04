import { join } from "node:path";
import { executeAction } from "./actions.js";
import type { BrowserManager } from "./browser/browser.js";
import { observe } from "./browser/observation.js";
import type { BudgetTracker } from "./budget.js";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { Oracle } from "./oracles.js";
import type {
  ConsoleRecord,
  Finding,
  FindingStatus,
  NetworkRecord,
  RecordedStep,
} from "./types.js";

export type ValidationAttemptResult = {
  attempt: number;
  reproduced: boolean;
  oracleResult: {
    oracleId: string;
    suspicious: boolean;
    expected: string;
    actual: string;
  };
};

export type ValidationOutcome = {
  finding: Finding;
  attempts: ValidationAttemptResult[];
  /** Native-capture evidence Playwright can only write straight to disk. */
  representativeEvidence: {
    screenshotPath?: string;
    tracePath?: string;
    consoleMessages: ConsoleRecord[];
    networkRequests: NetworkRecord[];
  };
};

export function decideStatus(successes: number, minimumSuccesses: number): FindingStatus {
  if (successes === 0) return "rejected";
  if (successes >= minimumSuccesses) return "validated";
  return "needs_human";
}

export type ValidatorDeps = {
  browserManager: BrowserManager;
  config: AppConfig;
  oracles: Oracle[];
  logger: Logger;
  /** Directory the caller has already created for this finding's evidence. */
  evidenceDir: string;
  /**
   * When provided, checked before each replay attempt; validation stops
   * early (not mid-attempt) if the run's wall-clock budget is exhausted.
   * Exploration counters (actions/model calls/pages) are NOT consumed by
   * replay -- reproduction isn't exploration -- only duration is enforced
   * here, since that's the one budget explicitly about never letting
   * anything, including validation, hang the run.
   */
  budget?: BudgetTracker;
};

/**
 * Reproduces a suspected finding in fresh, isolated browser contexts. Never
 * asks the model whether the bug reproduced — success is decided purely by
 * re-running the same deterministic oracle against a clean replay.
 */
export class Validator {
  constructor(private readonly deps: ValidatorDeps) {}

  async validate(finding: Finding): Promise<ValidationOutcome> {
    const { config, browserManager, oracles, logger, evidenceDir, budget } = this.deps;
    const oracle = oracles.find((candidate) => candidate.id === finding.oracle.oracleId);
    if (!oracle) {
      throw new Error(`Validator: unknown oracle id "${finding.oracle.oracleId}"`);
    }

    const totalAttempts = config.validation.attempts;
    const attempts: ValidationAttemptResult[] = [];
    let representativeEvidence: ValidationOutcome["representativeEvidence"] = {
      consoleMessages: [],
      networkRequests: [],
    };

    logger.info(
      { findingId: finding.id, attempts: totalAttempts },
      "Validator: starting clean-session reproduction"
    );

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      if (budget?.isDurationExceeded()) {
        logger.warn(
          { findingId: finding.id, attemptsCompleted: attempts.length, of: totalAttempts },
          "BUDGET_EXHAUSTED: stopping validation early (maxDurationMs)"
        );
        break;
      }

      const captureEvidence = attempt === 1;
      const session = await browserManager.newPageSession();

      try {
        if (captureEvidence) {
          await browserManager.startTracing(session.context);
        }

        await session.page.goto(finding.url);
        const before = await observe(session.page, session.records);

        for (const step of finding.steps) {
          await executeAction(session.page, step.action, config, logger);
        }

        const lastStep: RecordedStep =
          finding.steps[finding.steps.length - 1] ?? {
            number: 0,
            action: { type: "reload" },
            timestamp: new Date().toISOString(),
          };

        const screenshotPath =
          captureEvidence && config.evidence.screenshots
            ? join(evidenceDir, "screenshot.png")
            : undefined;

        const after = await observe(session.page, session.records, {
          ...(screenshotPath ? { screenshotPath } : {}),
        });

        const oracleResult = await oracle.evaluate(before, lastStep, after);
        attempts.push({
          attempt,
          reproduced: oracleResult.suspicious,
          oracleResult: {
            oracleId: oracleResult.oracleId,
            suspicious: oracleResult.suspicious,
            expected: oracleResult.expected,
            actual: oracleResult.actual,
          },
        });

        logger.info(
          { findingId: finding.id, attempt, of: totalAttempts, reproduced: oracleResult.suspicious },
          `Attempt ${attempt}/${totalAttempts}: ${oracleResult.suspicious ? "reproduced" : "not reproduced"}`
        );

        if (captureEvidence) {
          let tracePath: string | undefined;
          if (config.evidence.trace) {
            tracePath = join(evidenceDir, "trace.zip");
            await browserManager.stopTracing(session.context, tracePath);
          }
          representativeEvidence = {
            ...(screenshotPath ? { screenshotPath } : {}),
            ...(tracePath ? { tracePath } : {}),
            consoleMessages: after.consoleMessages,
            networkRequests: after.networkRequests,
          };
        }
      } finally {
        await browserManager.closeSession(session);
      }
    }

    const successes = attempts.filter((result) => result.reproduced).length;
    const status = decideStatus(successes, config.validation.minimumSuccesses);

    logger.info(
      { findingId: finding.id, successes, of: totalAttempts, status },
      `Finding ${status.toUpperCase()}.`
    );

    const validatedFinding: Finding = {
      ...finding,
      status,
      reproduction: { attempts: attempts.length, successes },
    };

    return { finding: validatedFinding, attempts, representativeEvidence };
  }
}
