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
export function createCheckRequester(profile: ProjectProfile, origin: string, budget: CheckBudget) {
  return async (pathname: string, method: string, body: unknown, cap: number, signal?: AbortSignal, headers?: Record<string, string>): Promise<CheckHttpResponse | CheckHttpError> => {
    if (profile.auth.mode !== "none") return { failed: true, reason: "Authenticated API checks are unsupported: browser sessions are not exported to the standalone HTTP client." };
    const url = scopedCheckUrl(profile, origin, pathname);
    if (!url) return { failed: true, reason: "Request is outside the approved origin or navigation.allowedPathPrefixes, or its path is non-canonical." };
    if (method !== "GET" && !profile.apiChecks.allowedMutatingEndpoints.some(e => e.method === method && e.pathname === pathname)) return { failed: true, reason: "Mutation is not explicitly authorized." };
    if (signal?.aborted || Date.now() >= budget.deadline) return { failed: true, reason: "Run cancelled or duration limit reached." };
    if (budget.used >= budget.max) return { failed: true, reason: "API request budget exhausted." };
    if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > 65536) return { failed: true, reason: "Request body exceeds the byte limit." };
    budget.used++;
    const deadline = AbortSignal.timeout(Math.max(1, budget.deadline - Date.now()));
    return fireCheckRequest(url.href, method, body, Math.min(cap, 1048576), signal ? AbortSignal.any([signal, deadline]) : deadline, headers);
  };
}
