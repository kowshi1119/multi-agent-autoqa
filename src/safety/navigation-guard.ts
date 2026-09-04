import type { BrowserContext, Page } from "playwright";
import { isOriginAllowed } from "../actions.js";
import type { Logger } from "../logger.js";
import type { SafetyEvent } from "../types.js";

function makeEvent(url: string, mechanism: SafetyEvent["mechanism"]): SafetyEvent {
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
export async function installRouteGuard(
  context: BrowserContext,
  allowedOrigins: string[],
  logger: Logger,
  onSafetyEvent: (event: SafetyEvent) => void
): Promise<void> {
  await context.route("**/*", (route) => {
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
    void route.continue();
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
