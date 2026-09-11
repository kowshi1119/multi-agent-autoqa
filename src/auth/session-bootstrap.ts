import type { BrowserContext, Page } from "playwright";
import { buildLocator } from "../actions.js";
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
  | { status: "failed"; reason: "invalid-credentials" | "missing-signal" | "success-url-mismatch" | "timeout" | "not-configured" };

export interface SessionBootstrap {
  establish(context: BrowserContext, page: Page, profile: ProjectProfile, credentials: TransientCredentials | undefined, logger: Logger): Promise<AuthResult>;
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
    logger: Logger
  ): Promise<AuthResult> {
    const auth = profile.auth;
    if (auth.mode !== "form-login" || !auth.loginUrl || !auth.usernameField || !auth.passwordField || !auth.submitControl || !auth.successUrlPattern || !auth.authenticatedSignal) {
      return { status: "failed", reason: "not-configured" };
    }
    if (!credentials) {
      logger.warn({}, "AUTH_FAILED: form-login profile requires credentials but none were supplied for this run");
      return { status: "failed", reason: "invalid-credentials" };
    }

    try {
      await page.goto(auth.loginUrl, { timeout: LOGIN_NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });

      const usernameLocator = buildLocator(page, auth.usernameField);
      await usernameLocator.fill(credentials.username, { timeout: LOGIN_NAV_TIMEOUT_MS });

      const passwordLocator = buildLocator(page, auth.passwordField);
      await passwordLocator.fill(credentials.password, { timeout: LOGIN_NAV_TIMEOUT_MS });

      const submitLocator = buildLocator(page, auth.submitControl);
      await submitLocator.click({ timeout: LOGIN_NAV_TIMEOUT_MS });

      // Both conditions must hold for success: the URL must actually match
      // successUrlPattern, AND the authenticatedSignal must be visible.
      // Previously the URL-wait's timeout was silently swallowed and
      // success was decided from signal-visibility alone -- a page that
      // never navigated at all (e.g. a validation error left the form in
      // place, with some unrelated always-visible element happening to
      // match authenticatedSignal) could read as a successful login.
      const urlMatched = await page
        .waitForURL(new RegExp(auth.successUrlPattern), { timeout: SIGNAL_WAIT_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);

      const signalLocator = buildLocator(page, auth.authenticatedSignal);
      const signalVisible = await signalLocator
        .waitFor({ state: "visible", timeout: SIGNAL_WAIT_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);

      if (!urlMatched) {
        logger.warn({}, "AUTH_FAILED: post-login URL never matched the profile's successUrlPattern");
        return { status: "failed", reason: "success-url-mismatch" };
      }

      if (!signalVisible) {
        logger.warn({}, "AUTH_FAILED: post-login authenticated-page signal never became visible");
        return { status: "failed", reason: "missing-signal" };
      }

      return { status: "success" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error: message }, "AUTH_FAILED: login sequence did not complete");
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
