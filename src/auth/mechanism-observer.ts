import type { Request } from "playwright";

export type AuthMechanismSummary = {
  /** Only fetch/XHR requests the application itself sent to an approved API origin after sign-in are counted. */
  origins: Array<{ origin: string; apiRequestsObserved: number; withCookie: number; withAuthorization: Record<string, number> }>;
  note: string;
};

/**
 * Observes how the application authenticates its OWN API calls during a
 * signed-in run, so API checks can say precisely which mechanism is (or is
 * not) supported instead of assuming one. Evidence contains only counts and
 * the Authorization scheme name (e.g. "Bearer") -- never cookie or header
 * values. When the profile explicitly opts in to
 * `apiChecks.runSessionAuth: "observed-authorization"`, the most recent
 * Bearer Authorization value per origin is additionally held in memory (never
 * written anywhere) so checks can reuse it for that same origin only.
 */
export class AuthMechanismObserver {
  private readonly counts = new Map<string, { apiRequestsObserved: number; withCookie: number; withAuthorization: Map<string, number> }>();
  private readonly authorization = new Map<string, string>();

  constructor(private readonly apiOrigins: readonly string[], private readonly retainAuthorization: boolean) {}

  async observe(request: Request): Promise<void> {
    if (!["fetch", "xhr"].includes(request.resourceType())) return;
    let origin: string;
    try { origin = new URL(request.url()).origin; } catch { return; }
    if (!this.apiOrigins.includes(origin)) return;
    // allHeaders() includes Cookie/Authorization; headers() deliberately omits them.
    const headers = await request.allHeaders().catch(() => ({} as Record<string, string>));
    const entry = this.counts.get(origin) ?? { apiRequestsObserved: 0, withCookie: 0, withAuthorization: new Map<string, number>() };
    entry.apiRequestsObserved++;
    if (headers["cookie"]) entry.withCookie++;
    const authorization = headers["authorization"];
    if (authorization) {
      const scheme = (/^(\S+)/.exec(authorization)?.[1] ?? "unknown").slice(0, 20);
      entry.withAuthorization.set(scheme, (entry.withAuthorization.get(scheme) ?? 0) + 1);
      // Only bearer tokens are retained: a Basic value IS the user's credentials.
      if (this.retainAuthorization && scheme.toLowerCase() === "bearer") this.authorization.set(origin, authorization);
    }
    this.counts.set(origin, entry);
  }

  /** The Authorization value the application itself last sent to exactly this origin, if retention was opted into. */
  authorizationFor(url: string): string | undefined {
    try { return this.authorization.get(new URL(url).origin); } catch { return undefined; }
  }

  /** Authorization scheme names (never values) the application used for this URL's origin. */
  schemesFor(url: string): string[] {
    try { return [...(this.counts.get(new URL(url).origin)?.withAuthorization.keys() ?? [])]; } catch { return []; }
  }

  /** Plain-language description of what was observed for one origin, for "unsupported" explanations. */
  describe(url: string): string {
    let origin: string;
    try { origin = new URL(url).origin; } catch { return "no application API call was observed"; }
    const entry = this.counts.get(origin);
    if (!entry || entry.apiRequestsObserved === 0) return "no application API call to this origin was observed during the run, so its authentication mechanism is unknown";
    const schemes = [...entry.withAuthorization.keys()];
    if (schemes.length) return `the application's own ${entry.apiRequestsObserved} API call(s) to this origin carried an Authorization header (${schemes.join(", ")})${entry.withCookie ? ` and ${entry.withCookie} carried cookies` : ""}`;
    return entry.withCookie ? `the application's own API calls to this origin carried cookies only` : "the application's own API calls to this origin carried neither cookies nor an Authorization header";
  }

  summary(): AuthMechanismSummary {
    return {
      origins: [...this.counts.entries()].map(([origin, e]) => ({ origin, apiRequestsObserved: e.apiRequestsObserved, withCookie: e.withCookie, withAuthorization: Object.fromEntries(e.withAuthorization) })),
      note: "Counts and Authorization scheme names only; no cookie or header values are recorded.",
    };
  }
}
