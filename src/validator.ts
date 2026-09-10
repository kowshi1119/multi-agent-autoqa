import { existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { executeAction } from "./actions.js";
import type { BrowserManager } from "./browser/browser.js";
import { observe } from "./browser/observation.js";
import type { BudgetTracker } from "./budget.js";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { Oracle } from "./oracles.js";
import { sameFailure } from "./oracles/signature.js";
import type {
  ConsoleRecord,
  EvidenceCompleteness,
  Finding,
  FindingStatus,
  NetworkRecord,
  PageErrorRecord,
  RecordedStep,
} from "./types.js";

export type ValidationAttemptResult = {
  attempt: number;
  /**
   * True only when this attempt's oracle result is suspicious AND matches
   * the ORIGINAL triggering finding's failure signature (see
   * oracles/signature.ts#sameFailure) -- a different failure from the
   * same oracle does not count as reproducing THIS finding. This is what
   * decideStatus() counts toward `successes`.
   */
  reproduced: boolean;
  /** True whenever the oracle fired at all, regardless of signature match -- diagnostic only, never fed into decideStatus(). */
  oracleSuspicious: boolean;
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
  /** 1-based attempt number representativeEvidence was captured from; 0 if validation never completed a single attempt (budget exhausted immediately). */
  representativeAttempt: number;
  evidenceCompleteness: EvidenceCompleteness;
  /** Native-capture evidence Playwright can only write straight to disk. */
  representativeEvidence: {
    screenshotPath?: string;
    tracePath?: string;
    consoleMessages: ConsoleRecord[];
    networkRequests: NetworkRecord[];
    pageErrors: PageErrorRecord[];
    /** First 500 chars of visible page text at the representative attempt's "after" observation -- what the Critic uses to judge documented UI text. */
    visibleTextExcerpt: string;
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

function deleteIfExists(path?: string): void {
  if (!path || !existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    /* best-effort cleanup of a superseded temp capture */
  }
}

function promoteToCanonical(
  evidence: ValidationOutcome["representativeEvidence"],
  evidenceDir: string
): ValidationOutcome["representativeEvidence"] {
  const result = { ...evidence };
  if (result.screenshotPath) {
    const canonical = join(evidenceDir, "screenshot.png");
    renameSync(result.screenshotPath, canonical);
    result.screenshotPath = canonical;
  }
  if (result.tracePath) {
    const canonical = join(evidenceDir, "trace.zip");
    renameSync(result.tracePath, canonical);
    result.tracePath = canonical;
  }
  return result;
}

/**
 * Reproduces a suspected finding in fresh, isolated browser contexts. Never
 * asks the model whether the bug reproduced — success is decided purely by
 * re-running the same deterministic oracle against a clean replay.
 *
 * Phase 3 change: evidence is captured from the FIRST attempt that
 * actually reproduces the original finding (matches its failure
 * signature), not always attempt 1. Every attempt is captured to a
 * temporary per-attempt file until a reproducing attempt is found and
 * "locks in" -- capture stops for every attempt after that, and the
 * locked-in candidate's temp files are renamed to the canonical
 * screenshot.png/trace.zip at the end. Exactly one of each is ever
 * persisted per finding regardless of how many attempts ran. If no
 * attempt reproduces, the LAST attempt's capture is kept, labeled
 * "diagnostic-no-success".
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
    const VISIBLE_TEXT_EXCERPT_CHARS = 500;

    let representativeAttempt = 0;
    let evidenceCompleteness: EvidenceCompleteness = "diagnostic-no-success";
    let representativeEvidence: ValidationOutcome["representativeEvidence"] = {
      consoleMessages: [],
      networkRequests: [],
      pageErrors: [],
      visibleTextExcerpt: "",
    };
    // Once a reproducing attempt is captured, every later attempt skips
    // capture entirely -- this is the whole cost-bounding mechanism.
    let locked = false;

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

      const captureThisAttempt = !locked;
      const session = await browserManager.newPageSession();

      try {
        if (captureThisAttempt) {
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

        const tempScreenshotPath =
          captureThisAttempt && config.evidence.screenshots
            ? join(evidenceDir, `screenshot.tmp-${attempt}.png`)
            : undefined;

        const after = await observe(session.page, session.records, {
          ...(tempScreenshotPath ? { screenshotPath: tempScreenshotPath } : {}),
        });

        const oracleResult = await oracle.evaluate(before, lastStep, after);
        const reproduced = oracleResult.suspicious && sameFailure(oracleResult, finding.oracle);
        attempts.push({
          attempt,
          reproduced,
          oracleSuspicious: oracleResult.suspicious,
          oracleResult: {
            oracleId: oracleResult.oracleId,
            suspicious: oracleResult.suspicious,
            expected: oracleResult.expected,
            actual: oracleResult.actual,
          },
        });

        logger.info(
          { findingId: finding.id, attempt, of: totalAttempts, reproduced, oracleSuspicious: oracleResult.suspicious },
          `Attempt ${attempt}/${totalAttempts}: ${reproduced ? "reproduced" : "not reproduced"}`
        );

        if (captureThisAttempt) {
          let tempTracePath: string | undefined;
          if (config.evidence.trace) {
            tempTracePath = join(evidenceDir, `trace.tmp-${attempt}.zip`);
            await browserManager.stopTracing(session.context, tempTracePath);
          }

          // !locked guaranteed captureThisAttempt===true, so any existing
          // candidate here is necessarily still "diagnostic-no-success" --
          // always safe to supersede it with this attempt's evidence.
          deleteIfExists(representativeEvidence.screenshotPath);
          deleteIfExists(representativeEvidence.tracePath);

          representativeAttempt = attempt;
          evidenceCompleteness = reproduced ? "representative-success" : "diagnostic-no-success";
          representativeEvidence = {
            ...(tempScreenshotPath ? { screenshotPath: tempScreenshotPath } : {}),
            ...(tempTracePath ? { tracePath: tempTracePath } : {}),
            consoleMessages: after.consoleMessages,
            networkRequests: after.networkRequests,
            pageErrors: after.pageErrors,
            visibleTextExcerpt: after.visibleText.slice(0, VISIBLE_TEXT_EXCERPT_CHARS),
          };

          if (reproduced) locked = true;
        }
      } finally {
        await browserManager.closeSession(session);
      }
    }

    representativeEvidence = promoteToCanonical(representativeEvidence, evidenceDir);

    const successes = attempts.filter((result) => result.reproduced).length;
    const status = decideStatus(successes, config.validation.minimumSuccesses);

    logger.info(
      { findingId: finding.id, successes, of: totalAttempts, status, representativeAttempt, evidenceCompleteness },
      `Finding ${status.toUpperCase()}.`
    );

    const validatedFinding: Finding = {
      ...finding,
      status,
      reproduction: { attempts: attempts.length, successes },
    };

    return { finding: validatedFinding, attempts, representativeAttempt, evidenceCompleteness, representativeEvidence };
  }
}
