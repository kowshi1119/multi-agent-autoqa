import type { BudgetTracker } from "../budget.js";
import type { BrowserContext, Page } from "playwright";
import { buildLocator, isCancellationError } from "../actions.js";
import type { Logger } from "../logger.js";
import type { ProjectProfile } from "../profiles/schema.js";

/**
 * Transient run input, never persisted. `password` is expected to be
 * sourced from process.env["QA_PASSWORD"] at the call site (see
 * resolveTransientCredentials()) -- redactSecrets() (src/redact.ts) already
 * strips that exact env var's value from every log line, evidence file,
 * and error message it's read fresh from process.env each call, so a
 * credential passed this way is covered by the existing redaction idiom
 * without any new pattern to maintain.
 */
export type TransientCredentials = { username: string; password: string };

export type AuthResult =
  | { status: "success" }
  | { status: "failed"; reason: "invalid-credentials" | "missing-signal" | "success-url-mismatch" | "timeout" | "not-configured" | "cancelled" | "budget-exhausted" };

export interface SessionBootstrap {
  establish(
    context: BrowserContext,
    page: Page,
    profile: ProjectProfile,
    credentials: TransientCredentials | undefined,
    logger: Logger,
    /** §8a fix (2026-09-14 addendum): a Stop pressed mid-login or between retries -- see BrowserManager#ensureAuthenticated for the bounded-cleanup semantics this actually provides. */
    signal?: AbortSignal,
    budget?: BudgetTracker
  ): Promise<AuthResult>;
}

export class NoAuthBootstrap implements SessionBootstrap {
  // eslint-disable-next-line @typescript-eslint/require-await
  async establish(): Promise<AuthResult> {
    return { status: "success" };
  }
}

const LOGIN_NAV_TIMEOUT_MS = 15_000;
const SIGNAL_WAIT_TIMEOUT_MS = 10_000;

/**
 * Generic, profile-driven form login -- never hardcodes OrangeHRM or any
 * other application. Every locator/URL-pattern field comes from
 * profile.auth (see src/profiles/schema.ts's authSchema); an adapter like
 * profiles/orangehrm.json is purely data for this one interpreter.
 *
 * Runs directly against `page`, NOT through executeAction()/QaAction --
 * login is a pre-step, never replayed as part of a finding's own steps
 * (see Validator.validate()'s insertion point).
 */
export class FormLoginBootstrap implements SessionBootstrap {
  async establish(
    _context: BrowserContext,
    page: Page,
    profile: ProjectProfile,
    credentials: TransientCredentials | undefined,
    logger: Logger,
    signal?: AbortSignal,
    budget?: BudgetTracker
  ): Promise<AuthResult> {
    // §8a fix (2026-09-14 addendum): an already-aborted signal at entry --
    // e.g. Stop pressed between BrowserManager's MAX_LOGIN_ATTEMPTS retries
    // -- must never start a fresh Playwright action. A signal that aborts
    // WHILE this attempt is already in flight is not interrupted (bounded
    // cleanup, not instant interruption -- see ensureAuthenticated()).
    if (signal?.aborted) {
      logger.info({}, "CANCELLED: login not attempted -- Stop was requested before this attempt began");
      return { status: "failed", reason: "cancelled" };
    }

    const auth = profile.auth;
    if (auth.mode !== "form-login" || !auth.loginUrl || !auth.usernameField || !auth.passwordField || !auth.submitControl || !auth.successUrlPattern || !auth.authenticatedSignal) {
      return { status: "failed", reason: "not-configured" };
    }
    if (auth.checksVerified === false) {
      logger.warn({}, "AUTH_NOT_CONFIGURED: authenticated URL and visible signal require observed configuration");
      return { status: "failed", reason: "not-configured" };
    }
    if (!credentials) {
      logger.warn({}, "AUTH_FAILED: form-login profile requires credentials but none were supplied for this run");
      return { status: "failed", reason: "invalid-credentials" };
    }

    // §Cancellation fix (2026-09-16): `signal` is now forwarded into every
    // Playwright call below (alongside its existing timeout), so Playwright
    // itself aborts an in-flight step the moment Stop fires -- not just
    // between steps. The between-step `signal?.aborted` checks are kept as
    // a cheap fast path (skip starting a new step at all) and, for the two
    // `.catch(() => false)`-guarded waits, as the mechanism that turns an
    // abort-triggered rejection into a correctly-labeled "cancelled" result
    // instead of a misleading "success-url-mismatch"/"missing-signal".
    // Previously Stop was only checked BETWEEN whole steps, bounding it to
    // the SUM of every remaining step's own timeout (~80s worst case); an
    // already-in-flight step now itself aborts genuinely, not just "no new
    // step starts."
    const cancelled = (): AuthResult => {
      logger.info({}, "CANCELLED: login sequence stopped mid-flow");
      return { status: "failed", reason: "cancelled" };
    };

    const perform = async (action: () => Promise<unknown>) => {
      budget?.recordAttempt("authentication");
      try { await action(); budget?.recordOutcome("success"); }
      catch (error) { budget?.recordOutcome("failed"); throw error; }
    };
    try {
      await perform(() => page.goto(auth.loginUrl!,  { timeout: LOGIN_NAV_TIMEOUT_MS, waitUntil: "domcontentloaded", signal }));
      if (signal?.aborted) return cancelled();

      const usernameLocator = buildLocator(page, auth.usernameField);
      await perform(() => usernameLocator.fill(credentials.username, { timeout: LOGIN_NAV_TIMEOUT_MS, signal }));
      if (signal?.aborted) return cancelled();

      const passwordLocator = buildLocator(page, auth.passwordField);
      await perform(() => passwordLocator.fill(credentials.password, { timeout: LOGIN_NAV_TIMEOUT_MS, signal }));
      if (signal?.aborted) return cancelled();

      const submitLocator = buildLocator(page, auth.submitControl);
      await perform(() => submitLocator.click({ timeout: LOGIN_NAV_TIMEOUT_MS, signal }));
      if (signal?.aborted) return cancelled();

      // Both conditions must hold for success: the URL must actually match
      // successUrlPattern, AND the authenticatedSignal must be visible.
      // Previously the URL-wait's timeout was silently swallowed and
      // success was decided from signal-visibility alone -- a page that
      // never navigated at all (e.g. a validation error left the form in
      // place, with some unrelated always-visible element happening to
      // match authenticatedSignal) could read as a successful login.
      const urlMatched = await page
        .waitForURL(new RegExp(auth.successUrlPattern), { timeout: SIGNAL_WAIT_TIMEOUT_MS, signal })
        .then(() => true)
        .catch(() => false);
      if (signal?.aborted) return cancelled();

      const signalLocator = buildLocator(page, auth.authenticatedSignal);
      const signalVisible = await signalLocator
        .waitFor({ state: "visible", timeout: SIGNAL_WAIT_TIMEOUT_MS, signal })
        .then(() => true)
        .catch(() => false);
      if (signal?.aborted) return cancelled();

      if (!urlMatched || !new RegExp(auth.successUrlPattern).test(page.url())) {
        logger.warn({}, "AUTH_FAILED: post-login URL never matched the profile's successUrlPattern");
        return { status: "failed", reason: "success-url-mismatch" };
      }

      if (!signalVisible) {
        logger.warn({}, "AUTH_FAILED: post-login authenticated-page signal never became visible");
        return { status: "failed", reason: "missing-signal" };
      }

      return { status: "success" };
    } catch (error) {
      if (budget && !budget.canAct() && !signal?.aborted) return { status: "failed", reason: "budget-exhausted" };
      if (isCancellationError(error)) return cancelled();
      logger.warn({}, "AUTH_FAILED: login sequence did not complete (timeout or unavailable control)");
      return { status: "failed", reason: "timeout" };
    }
  }
}

export function selectSessionBootstrap(profile: ProjectProfile): SessionBootstrap {
  if (profile.auth.mode === "none") return new NoAuthBootstrap();
  return new FormLoginBootstrap();
}

/**
 * Transient run input only -- never read from or written to a profile
 * file. Absent credentials (undefined) is a valid, expected state for a
 * "none"-mode profile; a form-login profile with no credentials set fails
 * explicitly (see FormLoginBootstrap) rather than silently proceeding
 * unauthenticated.
 */
export function resolveTransientCredentials(): TransientCredentials | undefined {
  const username = process.env["QA_USERNAME"];
  const password = process.env["QA_PASSWORD"];
  if (!username || !password) return undefined;
  return { username, password };
}
