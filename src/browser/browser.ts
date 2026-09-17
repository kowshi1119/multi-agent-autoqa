import type { BudgetTracker } from "../budget.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ProjectProfile } from "../profiles/schema.js";
import { buildLocator } from "../actions.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { credentialSecrets } from "../redact.js";
import type { ActionPolicy } from "../safety/action-policy.js";
import {
  installAsyncRedirectGuard,
  installPopupGuard,
  installRouteGuard,
} from "../safety/navigation-guard.js";
import type { SafetyEvent } from "../types.js";
import type { AuthResult, SessionBootstrap, TransientCredentials } from "../auth/session-bootstrap.js";
import { attachPageRecorders, createPageRecords, type PageRecords } from "./observation.js";

export class BrowserLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserLaunchError";
  }
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly reason: Exclude<AuthResult, { status: "success" }>["reason"]
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export type SessionAuthOptions = {
  sessionBootstrap: SessionBootstrap;
  profile: ProjectProfile;
  credentials?: TransientCredentials;
  /**
   * Reuse a previously captured authenticated storageState instead of
   * re-running the full login -- still re-verified via authenticatedSignal
   * on the fresh context (protected-page-accessibility verification), not
   * trusted blindly. Falls back to a full, bounded re-login if
   * verification fails (fresh contexts do not reset server-side session
   * expiry, so a stale storageState is an expected, not exceptional, case).
   */
  storageState?: StorageState;
};

const MAX_LOGIN_ATTEMPTS = 2;

export type PageSession = {
  context: BrowserContext;
  page: Page;
  records: PageRecords;
};

export class BrowserManager {
  private browser: Browser | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly headless: boolean,
    private readonly budget?: BudgetTracker
  ) {}

  async launch(): Promise<void> {
    try {
      this.browser = await chromium.launch({ headless: this.headless });
      this.logger.info(
        { headless: this.headless },
        "Chromium launched"
      );
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new BrowserLaunchError(
        `AutoQA could not start Chromium.\n\nTry:\nnpx playwright install chromium\n\nUnderlying error: ${cause}`
      );
    }
  }

  private requireBrowser(): Browser {
    if (!this.browser) {
      throw new BrowserLaunchError(
        "Browser has not been launched. Call launch() first."
      );
    }
    return this.browser;
  }

  async newPageSession(
    onSafetyEvent: (event: SafetyEvent) => void = () => {},
    actionPolicy?: ActionPolicy,
    authOptions?: SessionAuthOptions,
    /** §8a fix (2026-09-14 addendum) -- threaded to ensureAuthenticated()'s retry loop. */
    signal?: AbortSignal
  ): Promise<PageSession> {
    const browser = this.requireBrowser();
    const context = await browser.newContext({
      viewport: {
        width: this.config.browser.viewport.width,
        height: this.config.browser.viewport.height,
      },
      ...(authOptions?.storageState ? { storageState: authOptions.storageState } : {}),
    });

    const allowedOrigins = this.config.safety.allowedOrigins;
    let authenticating = Boolean(authOptions);
    const resourcePolicy = actionPolicy
      ? (method: string, pathname: string, origin: string, resourceType: string) => actionPolicy.classifyResourceRequest(method, pathname, origin, resourceType, authenticating)
      : undefined;
    await installRouteGuard(context, allowedOrigins, this.logger, onSafetyEvent, resourcePolicy);

    // Our own context.newPage() call below also fires the context-level
    // 'page' event (Playwright doesn't distinguish "we created this" from
    // "content opened a popup"), so the popup guard is installed only
    // *after* this page exists — otherwise it would immediately close the
    // very session page we're about to navigate, racing with that goto().
    const page = await context.newPage();
    if (this.budget) page.on("request", () => this.budget!.recordBrowserRequest(authenticating));
    installPopupGuard(context, allowedOrigins, this.logger, onSafetyEvent);
    installAsyncRedirectGuard(page, allowedOrigins, this.logger, onSafetyEvent);

    const records = createPageRecords();
    const extraSecrets = credentialSecrets(authOptions?.credentials);

    if (authOptions) {
      try {
        await this.ensureAuthenticated(context, page, authOptions, signal);
        authenticating = false;
      } catch (error) {
        // A session whose login never succeeded is not reusable -- close
        // it explicitly here rather than leaving it for the eventual
        // whole-browser teardown at run end to reap.
        await context.close().catch(() => {});
        throw error;
      }
    }

    // Evidence recorders are attached only AFTER authentication succeeds
    // (or immediately, when this session needs no auth at all) -- the
    // navigation/route/popup guards above stay active throughout login
    // either way, but console/network/dialog capture never sees the
    // credential-entry sequence itself.
    attachPageRecorders(page, records, extraSecrets);

    return { context, page, records };
  }

  /**
   * Authenticate BEFORE any evidence recorder/tracing has started seeing
   * "real" traffic and before the caller ever navigates -- called from
   * newPageSession() immediately after guard installation, ahead of every
   * other use of this session. A storageState carryover is re-verified
   * (protected-page-accessibility check), never trusted blindly; on
   * verification failure or when no storageState was supplied, runs a
   * bounded number of full form-login attempts rather than looping
   * indefinitely.
   */
  private async ensureAuthenticated(context: BrowserContext, page: Page, authOptions: SessionAuthOptions, signal?: AbortSignal): Promise<void> {
    const { sessionBootstrap, profile, credentials, storageState } = authOptions;

    if (storageState && profile.auth.mode === "form-login" && profile.auth.authenticatedSignal) {
      // A restored storageState only carries cookies/localStorage -- the
      // page itself is still blank until we navigate. Protected-page-
      // accessibility verification means actually loading the target and
      // confirming the authenticated signal renders there, not assuming
      // cookie presence equals a working session.
      this.budget?.recordAttempt("validation");
      const signalVisible = await page
        .goto(this.config.target.url, { timeout: 10_000, waitUntil: "domcontentloaded", signal })
        .then(() =>
          buildLocator(page, profile.auth.authenticatedSignal as NonNullable<typeof profile.auth.authenticatedSignal>).waitFor({
            state: "visible",
            timeout: 5_000,
            signal,
          })
        )
        .then(() => true)
        .catch(() => false);
      this.budget?.recordOutcome(signalVisible ? "success" : "failed");
      if (signalVisible && (!profile.auth.successUrlPattern || new RegExp(profile.auth.successUrlPattern).test(page.url()))) return;
      if (signal?.aborted) {
        this.logger.info({}, "CANCELLED: stopping before a fresh login attempt -- storageState verification was interrupted by Stop");
        throw new AuthenticationError("AUTH_FAILED: cancelled before storageState verification completed.", "cancelled");
      }
      this.logger.warn({}, "AUTH: carried-over storageState did not verify on a fresh context; falling back to a full re-login");
    }

    let lastResult: AuthResult = { status: "failed", reason: "timeout" };
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt += 1) {
      // §8a fix (2026-09-14 addendum): checked BETWEEN attempts, not just
      // once up front -- an attempt already in flight completes on its own
      // internal timeouts (bounded cleanup, not instant interruption), but
      // no NEW attempt starts once Stop has been requested.
      if (signal?.aborted) {
        this.logger.info({ attempt, of: MAX_LOGIN_ATTEMPTS }, "CANCELLED: stopping login retries early");
        lastResult = { status: "failed", reason: "cancelled" };
        break;
      }
      attemptsMade++;
      lastResult = await sessionBootstrap.establish(context, page, profile, credentials, this.logger, signal, this.budget);
      if (lastResult.status === "success") return;
      this.logger.warn({ attempt, of: MAX_LOGIN_ATTEMPTS, reason: lastResult.reason }, "AUTH_FAILED: login attempt did not succeed");
      if (["not-configured", "invalid-credentials", "cancelled", "budget-exhausted"].includes(lastResult.reason)) break;
    }

    throw new AuthenticationError(`AUTH_FAILED: could not establish an authenticated session after ${attemptsMade} attempt(s) (${lastResult.reason}).`, lastResult.reason);
  }

  async startTracing(context: BrowserContext): Promise<void> {
    if (!this.config.evidence.trace) return;
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }

  async stopTracing(context: BrowserContext, outputPath: string): Promise<void> {
    if (!this.config.evidence.trace) return;
    try {
      await context.tracing.stop({ path: outputPath });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: cause }, "Failed to write Playwright trace");
    }
  }

  async closeSession(session: PageSession): Promise<void> {
    await session.context.close();
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
