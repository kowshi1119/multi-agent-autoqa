import type { ProjectProfile } from "../profiles/schema.js";
import { pathWithinPrefix } from "../safety/action-policy.js";
import { fireCheckRequest, type CheckHttpError, type CheckHttpResponse } from "./http-client.js";

/** Shared across API/security, including confirmations and session probes. */
export type CheckBudget = { used: number; max: number; deadline: number };
export function checkBudget(profile: ProjectProfile): CheckBudget {
  return { used: 0, max: profile.limits.maxApiRequests ?? profile.limits.maxActions, deadline: Date.now() + profile.limits.maxDurationMs };
}
export function scopedCheckUrl(profile: ProjectProfile, origin: string, pathname: string): URL | undefined {
  try {
    const base = new URL(origin);
    const declared = new URL(profile.target.url);
    const local = profile.target.environmentKind === "local-fixture" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) && base.hostname === declared.hostname && base.protocol === declared.protocol;
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || (!local && !profile.navigation.allowedOrigins.includes(base.origin))) return;
    // This slice supports canonical literal paths only.
    if (!pathname.startsWith("/") || pathname.startsWith("//") || /[\\%?#\s]/.test(pathname)) return;
    const url = new URL(pathname, base);
    if (url.origin !== base.origin || url.pathname !== pathname) return;
    const prefixes = profile.navigation.allowedPathPrefixes;
    if (prefixes.length && !prefixes.some(prefix => pathWithinPrefix(pathname, prefix))) return;
    return url;
  } catch { return; }
}
/**
 * The current run's live authenticated browser session, exposed only while
 * that run's BrowserContext is still open (see run-pipeline.ts's
 * onSessionReady). Cookie values are read from the context per request and
 * held only in the request's own header -- never stored, logged or written
 * to evidence. `expired` is set by the requester the first time the target
 * rejects the session, so later checks stop instead of retrying.
 */
export type RunSession = {
  authenticated: boolean;
  loginPathname?: string;
  expired?: boolean;
  cookieHeaderFor(url: string): Promise<string | undefined>;
};

export type CheckSessionMode = "anonymous" | "run-session" | "expired" | "unavailable";

export function sessionModeFor(profile: ProjectProfile, session: RunSession | undefined): CheckSessionMode {
  if (profile.auth.mode === "none") return "anonymous";
  if (!profile.apiChecks.useRunSession || !session?.authenticated) return "unavailable";
  return session.expired ? "expired" : "run-session";
}

export function createCheckRequester(profile: ProjectProfile, origin: string, budget: CheckBudget, session?: RunSession) {
  const authenticated = profile.auth.mode !== "none";
  return async (pathname: string, method: string, body: unknown, cap: number, signal?: AbortSignal, headers?: Record<string, string>): Promise<CheckHttpResponse | CheckHttpError> => {
    if (authenticated && !profile.apiChecks.useRunSession) return { failed: true, reason: "Authenticated API checks are opt-in (apiChecks.useRunSession) and not enabled for this profile; no anonymous request was sent." };
    if (authenticated && !session?.authenticated) return { failed: true, reason: "No authenticated session exists for this run (authentication did not succeed or the session is closed); no anonymous request was sent." };
    if (authenticated && session?.expired) return { failed: true, sessionExpired: true, reason: "The authenticated session expired earlier in this run; no further authenticated requests were sent." };
    const url = scopedCheckUrl(profile, origin, pathname);
    if (!url) return { failed: true, reason: "Request is outside the approved origin or navigation.allowedPathPrefixes, or its path is non-canonical." };
    if (method !== "GET" && !profile.apiChecks.allowedMutatingEndpoints.some(e => e.method === method && e.pathname === pathname)) return { failed: true, reason: "Mutation is not explicitly authorized." };
    if (signal?.aborted || Date.now() >= budget.deadline) return { failed: true, reason: "Run cancelled or duration limit reached." };
    if (budget.used >= budget.max) return { failed: true, reason: "API request budget exhausted." };
    if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > 65536) return { failed: true, reason: "Request body exceeds the byte limit." };
    let requestHeaders = headers;
    if (authenticated) {
      // Resolved only after every scope/method/budget gate has passed, and
      // only for this exact approved URL -- Playwright applies the cookie
      // domain/path/secure rules. Browser route interception does NOT cover
      // this Node-side request, which is why the gates above are the only
      // (and complete) policy for it.
      const cookie = await session!.cookieHeaderFor(url.href);
      if (!cookie) return { failed: true, reason: "No session cookie applies to this URL (token- or storage-based sessions cannot be transferred); no anonymous request was sent." };
      requestHeaders = { ...headers, cookie };
    }
    budget.used++;
    const deadline = AbortSignal.timeout(Math.max(1, budget.deadline - Date.now()));
    const response = await fireCheckRequest(url.href, method, body, Math.min(cap, 1048576), signal ? AbortSignal.any([signal, deadline]) : deadline, requestHeaders);
    if (authenticated && !("failed" in response) && sessionRejected(response, url, session!.loginPathname)) {
      session!.expired = true;
      return { failed: true, sessionExpired: true, reason: `The target rejected the authenticated session (HTTP ${response.status}${response.status >= 300 && response.status < 400 ? ", redirect to login" : ""}); the response was not evaluated.` };
    }
    return response;
  };
}

/** Redirects are never followed by checks; a 401/440 or a redirect to the login page means the run's session is no longer accepted. */
function sessionRejected(response: CheckHttpResponse, url: URL, loginPathname: string | undefined): boolean {
  if (response.status === 401 || response.status === 440) return true;
  if (response.status < 300 || response.status >= 400 || !loginPathname) return false;
  try {
    const target = new URL(response.headers["location"] ?? "", url);
    return target.origin === url.origin && target.pathname === loginPathname;
  } catch { return false; }
}
