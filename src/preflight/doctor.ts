import { chromium } from "playwright";
import type { AppConfig, ConfigError } from "../config.js";
import { selectCriticProvider, selectProvider } from "../run-pipeline.js";
import type { Logger } from "../logger.js";
import type { ProjectProfile } from "./../profiles/schema.js";

export type PreflightStatus = "pass" | "fail" | "skipped";

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

/** A single bounded reachability probe against the ONE configured target URL -- never a port scan, never any other path. */
async function checkTargetReachable(targetUrl: string): Promise<PreflightCheck> {
  try {
    const response = await fetch(targetUrl, { method: "GET", signal: AbortSignal.timeout(TARGET_REACHABILITY_TIMEOUT_MS) });
    return {
      id: "target-reachable",
      name: "Target reachable",
      status: "pass",
      detail: `${targetUrl} responded with HTTP ${response.status}.`,
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
  const targetOrigin = new URL(profile.target.url).origin;
  if (!profile.navigation.allowedOrigins.includes(targetOrigin)) {
    return {
      id: "scope-consistency",
      name: "Navigation scope consistency",
      status: "fail",
      detail: `Target origin ${targetOrigin} is not included in navigation.allowedOrigins.`,
      nextStep: `Add "${targetOrigin}" to the profile's navigation.allowedOrigins.`,
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
  const checks: PreflightCheck[] = [
    { id: "profile-schema", name: "Profile schema", status: "pass", detail: "Profile parsed and validated successfully." },
    await checkChromiumLaunchable(),
    await checkTargetReachable(profile.target.url),
    checkScopeConsistency(profile),
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
