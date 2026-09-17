import type { BrowserContext, Page, Route } from "playwright";
import { isOriginAllowed } from "../actions.js";
import { isStaticAssetResourceType } from "./action-policy.js";
import type { Logger } from "../logger.js";
import type { SafetyEvent } from "../types.js";

type ResourcePolicy = (
  method: string,
  pathname: string,
  origin: string,
  resourceType: string
) => { decision: "allowed" } | { decision: "denied"; reason: string };

type NavigationBlockedMechanism = "route" | "post-action" | "framenavigated" | "popup";

function makeEvent(url: string, mechanism: NavigationBlockedMechanism): SafetyEvent {
  return { code: "SAFETY_NAVIGATION_BLOCKED", url, mechanism, timestamp: new Date().toISOString() };
}

/** Excludes browser-internal transitional states (about:blank, data:) from origin checks. */
function isRealNavigationTarget(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * Only the session's very first, natural "about:blank" should be ignored.
 * Notably `chrome-error://chromewebdata/` -- the interstitial Chromium
 * shows after route.abort() fails a top-level navigation -- is NOT benign:
 * it must still trigger a revert, or the page is left stranded on an error
 * screen after a legitimately blocked off-origin navigation.
 */
function isBenignTransitionalUrl(url: string): boolean {
  return url === "about:blank";
}

/**
 * Defense-in-depth against off-origin navigation, layered so no single
 * mechanism has to be perfect:
 *
 *  1. (this file, installRouteGuard) network-level preventive block via
 *     context.route() — aborts an off-origin main-frame navigation request
 *     before the browser ever commits to it.
 *  2. (src/actions.ts) synchronous post-action URL check + revert, for
 *     anything that slips past routing.
 *  3. (this file, installAsyncRedirectGuard) page.on('framenavigated') —
 *     catches a delayed redirect that completes after the triggering
 *     action's own await already resolved.
 *  4. (this file, installPopupGuard) context.on('page') — closes every
 *     popup/new tab (off-origin or not: Phase 1 explores one tab at a
 *     time, so even a same-origin popup would just be an unexplored dead
 *     end; only an off-origin one is recorded as a safety event).
 *
 * Scoped to the main frame only — iframes are out of scope for Phase 1.
 */
/** Bounded defense against a redirect loop -- deny rather than chase forever. */
const MAX_REDIRECT_HOPS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 301/302/303 conventionally downgrade a non-GET/HEAD method to GET (the
 * behavior effectively every browser and HTTP client implements, standards
 * text notwithstanding); 307/308 always preserve the original method and
 * body. 303 always becomes GET regardless of the original method.
 */
function methodForRedirect(status: number, originalMethod: string): string {
  if (status === 303) return "GET";
  if ((status === 301 || status === 302) && originalMethod !== "GET" && originalMethod !== "HEAD") return "GET";
  return originalMethod;
}

function classifyUrl(urlString: string, method: string, resourceType: string, resourcePolicy: ResourcePolicy): { decision: "allowed" } | { decision: "denied"; reason: string } {
  let pathname: string;
  let origin: string;
  try {
    const parsed = new URL(urlString);
    pathname = parsed.pathname;
    origin = parsed.origin;
  } catch {
    pathname = urlString;
    origin = "";
  }
  return resourcePolicy(method, pathname, origin, resourceType);
}

/**
 * Manually walks a request's own redirect chain, Node-side, validating
 * every hop against `resourcePolicy` BEFORE that hop is ever fetched -- by
 * anyone. This exists because Playwright's context.route() handler is
 * invoked only once, for a request's ORIGINAL url; if the response is a
 * redirect, the browser follows it natively without giving the handler
 * another chance to inspect or block the destination (confirmed
 * empirically, 2026-09-14: an allowed same-origin start URL redirecting to
 * an out-of-scope destination resulted in a REAL request reaching that
 * destination, with policy checked only once, for the original URL --
 * contradicting an earlier assumption in this file that route() re-checks
 * every hop). Detecting-and-reverting after the fact
 * (installAsyncRedirectGuard, below) is too late: the forbidden request
 * has already been sent by the time a framenavigated event fires.
 *
 * Once the ENTIRE chain is confirmed in-scope, only the FIRST hop's real,
 * already-fetched redirect response is relayed to the browser via
 * route.fulfill() -- which then follows it (and any further hops)
 * NATIVELY. Every one of those further hops was already independently
 * pre-validated by this same walk, so the browser's native (redundant,
 * but harmless) re-fetch of them can only ever reach destinations already
 * confirmed in-scope. This is deliberate: fulfilling the ORIGINAL request
 * directly with the deep-chased terminal content instead would leave
 * page.url() stuck on the pre-redirect URL (Playwright's frame navigation
 * reflects the URL it was asked to fetch, not wherever a manually-
 * fulfilled body actually came from) -- which would break
 * FormLoginBootstrap's page.waitForURL(successUrlPattern) after an
 * ordinary server-side post-login redirect, ubiquitous in real apps, and
 * something a redirect-safety fix must not break.
 */
async function chaseAndValidate(route: Route, resourcePolicy: ResourcePolicy, logger: Logger, onSafetyEvent: (event: SafetyEvent) => void): Promise<void> {
  const originalRequest = route.request();
  const resourceType = originalRequest.resourceType();
  let currentUrl = originalRequest.url();
  let currentMethod = originalRequest.method();
  let firstHopResponse: Awaited<ReturnType<Route["fetch"]>> | undefined;

  const deny = (reason: string, deniedUrl: string): void => {
    logger.warn({ url: deniedUrl, method: currentMethod, reason }, "ACTION_POLICY_DENIED: aborted unapproved resource request");
    onSafetyEvent({ code: "ACTION_POLICY_DENIED", reason, mechanism: "route", timestamp: new Date().toISOString() });
    void route.abort();
  };

  const initial = classifyUrl(currentUrl, currentMethod, resourceType, resourcePolicy);
  if (initial.decision === "denied") {
    deny(initial.reason, currentUrl);
    return;
  }

  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    let response: Awaited<ReturnType<Route["fetch"]>>;
    try {
      response = await route.fetch({ url: currentUrl, method: currentMethod, maxRedirects: 0 });
    } catch (error) {
      deny("ACTION_POLICY_DENIED: request/redirect validation failed; transport unavailable or cancelled", currentUrl);
      return;
    }
    if (hop === 0) firstHopResponse = response;

    const status = response.status();
    if (!REDIRECT_STATUSES.has(status)) {
      // Terminal (non-redirect) response. hop===0 means this was never a
      // chain at all -- relay exactly what was fetched, identical to
      // route.continue(). hop>0 means the chain was fully validated --
      // relay only the FIRST hop's real redirect and let the browser
      // follow the (already-vetted) rest natively, per this function's
      // own doc comment.
      await route.fulfill({ response: hop === 0 ? response : (firstHopResponse as NonNullable<typeof firstHopResponse>) });
      return;
    }

    const location = response.headers()["location"];
    if (!location) {
      // A 3xx with no Location header is malformed but not itself unsafe -- relay as-is rather than guessing.
      await route.fulfill({ response: hop === 0 ? response : (firstHopResponse as NonNullable<typeof firstHopResponse>) });
      return;
    }

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).href;
    } catch {
      deny(`ACTION_POLICY_DENIED: redirect Location header "${location}" could not be resolved to a valid URL`, currentUrl);
      return;
    }
    const nextMethod = methodForRedirect(status, currentMethod);

    // The redirect destination is classified BEFORE it is ever fetched --
    // by me or the browser. This is what makes "zero hits on the
    // forbidden destination" achievable.
    const classification = classifyUrl(nextUrl, nextMethod, resourceType, resourcePolicy);
    if (classification.decision === "denied") {
      deny(classification.reason, nextUrl);
      return;
    }

    currentUrl = nextUrl;
    currentMethod = nextMethod;
  }

  deny(`ACTION_POLICY_DENIED: redirect chain exceeded ${MAX_REDIRECT_HOPS} hops`, currentUrl);
}

export async function installRouteGuard(
  context: BrowserContext,
  allowedOrigins: string[],
  logger: Logger,
  onSafetyEvent: (event: SafetyEvent) => void,
  /**
   * Real-target action safety (Phase 4 Milestone A2), request-level
   * defense-in-depth: an XHR/fetch whose method is state-changing and
   * whose pathname isn't on the profile's explicit allowlist is aborted
   * here too, catching mutations that never went through an observed
   * click/Enter (e.g. a JS handler firing fetch() directly). Absent for a
   * local-fixture profile/legacy direct-YAML run.
   */
  resourcePolicy?: ResourcePolicy
): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (request.isNavigationRequest()) {
      // A popup's very first navigation request can throw here — its frame
      // isn't constructed yet when the request object is created. Treat an
      // indeterminate frame as main-frame (the conservative choice: we'd
      // rather apply the origin check than silently skip it).
      let isMainFrame = true;
      try {
        const frame = request.frame();
        isMainFrame = frame === frame.page()?.mainFrame();
      } catch {
        isMainFrame = true;
      }

      if (isMainFrame && !isOriginAllowed(request.url(), allowedOrigins)) {
        const event = makeEvent(request.url(), "route");
        logger.warn(event, "SAFETY_NAVIGATION_BLOCKED: aborted off-origin navigation request");
        onSafetyEvent(event);
        void route.abort();
        return;
      }
    }

    if (!resourcePolicy || (isStaticAssetResourceType(request.resourceType()) && ["GET", "HEAD"].includes(request.method().toUpperCase()))) {
      void route.continue();
      return;
    }

    await chaseAndValidate(route, resourcePolicy, logger, onSafetyEvent);
  });
}

export function installAsyncRedirectGuard(
  page: Page,
  allowedOrigins: string[],
  logger: Logger,
  onSafetyEvent: (event: SafetyEvent) => void
): void {
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (isBenignTransitionalUrl(url)) return;
    if (!isOriginAllowed(url, allowedOrigins)) {
      const event = makeEvent(url, "framenavigated");
      logger.warn(event, "SAFETY_NAVIGATION_BLOCKED: reverting off-origin/error navigation");
      onSafetyEvent(event);
      void page
        .goBack({ waitUntil: "domcontentloaded" })
        .catch(() => page.goto(allowedOrigins[0] ?? url).catch(() => {}));
    }
  });
}

export function installPopupGuard(
  context: BrowserContext,
  allowedOrigins: string[],
  logger: Logger,
  onSafetyEvent: (event: SafetyEvent) => void
): void {
  context.on("page", (newPage) => {
    void newPage
      .waitForLoadState("domcontentloaded")
      .catch(() => {})
      .then(() => {
        const url = newPage.url();
        // A confirmed off-origin popup requires a real (http/https) URL —
        // route guard layer 1 often blocks the popup's own navigation
        // request before it ever resolves to one, leaving url() blank;
        // that's still closed below, just not double-counted as a
        // separately "confirmed" safety event on top of layer 1's own.
        const confirmedOffOrigin = isRealNavigationTarget(url) && !isOriginAllowed(url, allowedOrigins);
        logger.warn(
          { url, confirmedOffOrigin },
          confirmedOffOrigin
            ? "SAFETY_NAVIGATION_BLOCKED: closing off-origin popup/new tab"
            : "Closing popup/new tab (Phase 1 explores one tab at a time)"
        );
        if (confirmedOffOrigin) onSafetyEvent(makeEvent(url, "popup"));
        return newPage.close().catch(() => {});
      });
  });
}
