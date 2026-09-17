import { chromium } from "playwright";
import type { AppConfig, ConfigError } from "../config.js";
import { selectCriticProvider, selectProvider } from "../run-pipeline.js";
import type { Logger } from "../logger.js";
import type { ProjectProfile } from "./../profiles/schema.js";
import { pathWithinPrefix } from "../safety/action-policy.js";

/**
 * "managed" (Phase 4 continuation) is distinct from "pass": the check
 * genuinely was not probed, because a local-fixture target's server is
 * started automatically when a run begins (see run-pipeline.ts), not
 * ahead of time -- a fixture profile's own doctor/preflight check must
 * never block readiness on a server that isn't supposed to exist yet.
 */
export type PreflightStatus = "pass" | "fail" | "skipped" | "managed";

export type ProviderState =
  | "not-configured"
  | "configured-but-unverified"
  | "verified-by-successful-live-request"
  | "rate-limited"
  | "unavailable"
  | "unsupported";

export type PreflightCheck = {
  id: string;
  name: string;
  status: PreflightStatus;
  detail: string;
  nextStep?: string;
};

export type PreflightReport = {
  profileId: string;
  overallReady: boolean;
  checks: PreflightCheck[];
};

const TARGET_REACHABILITY_TIMEOUT_MS = 5_000;
const CHROMIUM_LAUNCH_TIMEOUT_MS = 8_000;

async function checkChromiumLaunchable(): Promise<PreflightCheck> {
  try {
    const browser = await chromium.launch({ headless: true, timeout: CHROMIUM_LAUNCH_TIMEOUT_MS });
    await browser.close();
    return { id: "browser", name: "Chromium launchable", status: "pass", detail: "Chromium launched and closed successfully." };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      id: "browser",
      name: "Chromium launchable",
      status: "fail",
      detail: `Could not launch Chromium: ${cause}`,
      nextStep: "Run: npx playwright install chromium",
    };
  }
}

/**
 * A single bounded reachability probe against the ONE configured target
 * URL -- never a port scan, never any other path. Confirmed Phase 4
 * continuation gap: a local-fixture target's server is only started
 * inside runPipeline() when a run actually begins (see
 * run-pipeline.ts#runPipeline), so probing it here, before any run has
 * started, would always fail with connection-refused -- that's expected
 * and managed, never a real readiness problem, so it must not block
 * overallReady the way an actual unreachable real target should.
 *
 * 2026-09-11 independent-review fix: this used to run BEFORE
 * checkScopeConsistency(), so a live GET could be issued to a target
 * whose origin isn't even declared in navigation.allowedOrigins --
 * confirmed via a fake-route probe. `scopeConsistent` is now required
 * before this probe runs at all (see runPreflight()'s new ordering);
 * when it's false, report "skipped" rather than issuing any request.
 * `redirect: "manual"` is also new: the previous default ("follow")
 * transparently chased a redirect chain with zero scope checking on any
 * hop. A 3xx response is itself sufficient evidence the target
 * responded -- that's what reachability means here -- so it's reported
 * as reachable without following it anywhere.
 */
async function checkTargetReachable(profile: ProjectProfile, scopeConsistent: boolean): Promise<PreflightCheck> {
  if (profile.target.environmentKind === "local-fixture") {
    return {
      id: "target-reachable",
      name: "Target reachable",
      status: "managed",
      detail: "Local fixture server is started automatically when a run begins -- not probed ahead of time.",
    };
  }

  if (!scopeConsistent) {
    return {
      id: "target-reachable",
      name: "Target reachable",
      status: "skipped",
      detail: "Not probed: the target's own origin is not within the profile's declared navigation scope -- fix scope consistency first.",
    };
  }

  const targetUrl = profile.target.url;
  try {
    const response = await fetch(targetUrl, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TARGET_REACHABILITY_TIMEOUT_MS) });
    // 2026-09-14 addendum fix: a 3xx here is response/reachability evidence
    // only -- "the server answered" -- never proof the redirected
    // destination is itself reachable, in scope, or that any
    // authenticated access succeeded. Worded explicitly so this isn't
    // read as more than it is.
    const detail =
      response.status >= 300 && response.status < 400
        ? `${targetUrl} responded with HTTP ${response.status} (a redirect) -- this confirms the server responded, not that the redirected destination is reachable, in scope, or that authenticated access succeeded.`
        : `${targetUrl} responded with HTTP ${response.status}.`;
    return {
      id: "target-reachable",
      name: "Target reachable",
      status: "pass",
      detail,
    };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      id: "target-reachable",
      name: "Target reachable",
      status: "fail",
      detail: `Could not reach ${targetUrl}: ${cause}`,
      nextStep: "Confirm the target is running locally and the URL/port in the profile is correct.",
    };
  }
}

function checkScopeConsistency(profile: ProjectProfile): PreflightCheck {
  const targetUrl = new URL(profile.target.url);
  const targetOrigin = targetUrl.origin;
  if (!profile.navigation.allowedOrigins.includes(targetOrigin)) {
    return {
      id: "scope-consistency",
      name: "Navigation scope consistency",
      status: "fail",
      detail: `Target origin ${targetOrigin} is not included in navigation.allowedOrigins.`,
      nextStep: `Add "${targetOrigin}" to the profile's navigation.allowedOrigins.`,
    };
  }

  // 2026-09-14 addendum fix: an allowed ORIGIN doesn't mean the target's
  // own PATH is in scope -- previously never checked here at all, so a
  // target pointed outside navigation.allowedPathPrefixes still passed
  // scope-consistency and got probed for reachability regardless. The
  // login URL is a deliberate, separate exception (checked below, origin
  // only) -- a login page is commonly outside the app's main content
  // path scope by design, so it is never subjected to this same check.
  const prefixes = profile.navigation.allowedPathPrefixes;
  if (prefixes.length > 0 && !prefixes.some((prefix) => pathWithinPrefix(targetUrl.pathname, prefix))) {
    return {
      id: "scope-consistency",
      name: "Navigation scope consistency",
      status: "fail",
      detail: `Target path "${targetUrl.pathname}" is not within any of the profile's navigation.allowedPathPrefixes.`,
      nextStep: `Add a prefix covering "${targetUrl.pathname}" to the profile's navigation.allowedPathPrefixes, or correct target.url.`,
    };
  }

  if (profile.auth.mode === "form-login" && profile.auth.loginUrl) {
    const loginOrigin = new URL(profile.auth.loginUrl).origin;
    if (!profile.navigation.allowedOrigins.includes(loginOrigin)) {
      return {
        id: "scope-consistency",
        name: "Navigation scope consistency",
        status: "fail",
        detail: `Login URL origin ${loginOrigin} is not included in navigation.allowedOrigins.`,
        nextStep: `Add "${loginOrigin}" to the profile's navigation.allowedOrigins.`,
      };
    }
  }
  return { id: "scope-consistency", name: "Navigation scope consistency", status: "pass", detail: "Target and login origins are within the profile's allowed navigation scope." };
}

function checkAuthConfiguration(profile: ProjectProfile): PreflightCheck {
  if (profile.auth.mode === "form-login" && profile.auth.checksVerified === false) {
    return { id: "auth-config", name: "Login configuration", status: "fail", detail: "Authenticated URL and visible signal are unverified placeholders.", nextStep: "Observe the authenticated landing URL and a specific visible page signal using the dedicated sandbox account, then update auth success checks and set checksVerified=true. Do not paste credentials into chat." };
  }
  if (profile.auth.mode === "none") {
    return { id: "auth-config", name: "Login configuration", status: "skipped", detail: "Profile auth.mode is \"none\" -- no login required." };
  }
  // Required locator fields for form-login are already enforced by
  // projectProfileSchema's superRefine, so reaching this point with a
  // parsed profile means they're present. This check exists as its own
  // named result rather than being silently implied by "the profile
  // parsed at all".
  return { id: "auth-config", name: "Login configuration", status: "pass", detail: "All required form-login locator fields are present." };
}

/**
 * "verified-by-successful-live-request" is a real state in the
 * ProviderState vocabulary but intentionally not reachable from doctor in
 * this build: neither ExplorerProvider nor CriticProvider exposes a
 * cheap, single-token "ping" primitive today (both interfaces are shaped
 * around full QA-decision calls), and doctor must never make a paid model
 * call by default. Reaching here with no ConfigError thrown means
 * selection succeeded and credentials resolved -- reported honestly as
 * "configured-but-unverified", not upgraded to "verified" without an
 * actual request having happened.
 */
function checkProviders(config: AppConfig, logger: Logger): PreflightCheck {
  let explorerState: ProviderState;
  let explorerDetail: string;
  try {
    const provider = selectProvider(config, logger);
    explorerState = provider.name === "mock" ? "not-configured" : "configured-but-unverified";
    explorerDetail = `Explorer provider resolved: ${provider.name}.`;
  } catch (error) {
    const configError = error as ConfigError;
    explorerState = "unavailable";
    explorerDetail = configError.message;
  }

  let criticState: ProviderState;
  let criticDetail: string;
  try {
    const provider = selectCriticProvider(config, logger);
    if (!provider) {
      criticState = "not-configured";
      criticDetail = "Critic disabled by config (models.critic.enabled=false).";
    } else {
      criticState = provider.name === "mock" ? "not-configured" : "configured-but-unverified";
      criticDetail = `Critic provider resolved: ${provider.name}.`;
    }
  } catch (error) {
    const configError = error as ConfigError;
    criticState = "unavailable";
    criticDetail = configError.message;
  }

  const failed = explorerState === "unavailable" || criticState === "unavailable";
  return {
    id: "providers",
    name: "Provider configuration",
    status: failed ? "fail" : "pass",
    detail: `Explorer: ${explorerState} (${explorerDetail}) | Critic: ${criticState} (${criticDetail})`,
    ...(failed ? { nextStep: "Set the required API key environment variable, or switch the profile's provider to \"mock\"." } : {}),
  };
}

/**
 * Bounded, target-scoped diagnostic checks. Never opens an exploration
 * run, never makes a paid model call, never probes anything beyond the
 * one URL the profile itself configures.
 */
export async function runPreflight(profile: ProjectProfile, config: AppConfig, logger: Logger): Promise<PreflightReport> {
  // Scope consistency now runs BEFORE the live reachability probe (2026-09-11
  // independent-review fix) -- checkTargetReachable() reads its result and
  // skips issuing any request at all when the target's own origin isn't
  // within the profile's declared scope.
  const scopeConsistency = checkScopeConsistency(profile);
  const checks: PreflightCheck[] = [
    { id: "profile-schema", name: "Profile schema", status: "pass", detail: "Profile parsed and validated successfully." },
    await checkChromiumLaunchable(),
    scopeConsistency,
    await checkTargetReachable(profile, scopeConsistency.status !== "fail"),
    checkAuthConfiguration(profile),
    checkProviders(config, logger),
  ];

  return {
    profileId: profile.id,
    overallReady: checks.every((c) => c.status !== "fail"),
    checks,
  };
}

/** Used by doctor-cli.ts when a profile/config fails to even parse -- schema validity itself is the one failed check, nothing else runs. */
export function schemaFailureReport(profileId: string, message: string): PreflightReport {
  return {
    profileId,
    overallReady: false,
    checks: [{ id: "profile-schema", name: "Profile schema", status: "fail", detail: message, nextStep: "Fix the profile JSON and re-run doctor." }],
  };
}
