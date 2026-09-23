import { chromium, type Page, type Browser } from "playwright";
import { buildLocator } from "../actions.js";
import type { Logger } from "../logger.js";
import type { ProjectProfile } from "../profiles/schema.js";
import { credentialSecrets, redactSecrets } from "../redact.js";
import { ActionPolicy, pathWithinPrefix } from "../safety/action-policy.js";
import { installRouteGuard } from "../safety/navigation-guard.js";

export type AuthDiscoveryCredentials = { username: string; password: string };
export type CandidateSignal = { role: string; name: string };
export type AuthDiscoveryResult =
  | { status: "observed"; observedUrl: string; successUrlPattern: string; candidateSignals: CandidateSignal[] }
  | { status: "failed"; reason: string };

/** Validate through SessionBootstrap's actual locator. Visible text inside
 * a banner/main/nav is not that element's accessible name. */
export async function discoverSignals(page: Page, secrets: readonly string[] = []): Promise<CandidateSignal[]> {
  const candidates = await page.evaluate(() => {
    const results: Array<{ role: string; name: string }> = [];
    const elements = document.querySelectorAll('h1,h2,[role="heading"],nav,[role="navigation"],main,[role="main"],header,[role="banner"]');
    for (const el of Array.from(elements).slice(0, 50)) {
      const role = el.getAttribute("role") || ({ H1: "heading", H2: "heading", NAV: "navigation", MAIN: "main", HEADER: "banner" } as Record<string, string>)[el.tagName];
      if (!role || !["heading", "navigation", "main", "banner"].includes(role)) continue;
      const labelled = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || "").join(" ").trim();
      const name = (labelled || el.getAttribute("aria-label") || (role === "heading" ? el.textContent : "") || "").replace(/\s+/g, " ").trim();
      if (name && name.length <= 120) results.push({ role, name });
    }
    return results;
  });
  const result: CandidateSignal[] = [];
  for (const target of candidates) {
    if (redactSecrets(target.name, secrets) !== target.name) continue;
    const locator = buildLocator(page, target);
    if (await locator.count() === 1 && await locator.isVisible() && !result.some(s => s.role === target.role && s.name === target.name)) result.push(target);
    if (result.length === 5) break;
  }
  return result;
}

/** One bounded observation, never an accepted run. No recorder, storage
 * export, trace, screenshot, or raw browser-error logging. */
export async function runAuthDiscovery(profile: ProjectProfile, credentials: AuthDiscoveryCredentials, logger: Logger, signal?: AbortSignal): Promise<AuthDiscoveryResult> {
  const fail = (reason: string): AuthDiscoveryResult => ({ status: "failed", reason });
  const auth = profile.auth;
  if (auth.mode !== "form-login" || !auth.loginUrl || !auth.usernameField || !auth.passwordField || !auth.submitControl) return fail("Form login needs a login URL and username, password and submit controls.");
  if (!profile.navigation.allowedOrigins.includes(new URL(auth.loginUrl).origin)) return fail("Login URL is outside the approved origin scope.");
  if (profile.limits.maxActions < 4) return fail("The configured action limit cannot cover the four login setup actions.");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), Math.min(profile.limits.maxDurationMs, 60_000));
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let browser: Browser | undefined;
  const abort = () => { void browser?.close().catch(() => {}); };
  combined.addEventListener("abort", abort, { once: true });
  // Guard diagnostics may contain hostile URLs echoing credentials.
  const quietLogger = logger.child({}, { level: "silent" });
  try {
    if (combined.aborted) return fail("Discovery cancelled.");
    browser = await chromium.launch({ headless: true, timeout: Math.min(profile.limits.maxDurationMs, 10_000) });
    if (combined.aborted) return fail(signal?.aborted ? "Discovery cancelled." : "Discovery timed out.");
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    const policy = new ActionPolicy(profile);
    const login = new URL(auth.loginUrl);
    let authenticating = true;
    let policyBlocked = false;
    await installRouteGuard(context, profile.navigation.allowedOrigins, quietLogger, () => { policyBlocked = true; },
      (method, pathname, origin, resourceType) => policy.classifyResourceRequest(method, pathname, origin, resourceType, authenticating));
    const page = await context.newPage();
    context.on("page", popup => { if (popup !== page) void popup.close().catch(() => {}); });
    page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
    page.on("framenavigated", frame => {
      if (frame !== page.mainFrame()) return;
      try {
        const url = new URL(frame.url());
        if (url.protocol.startsWith("http") && (url.origin !== login.origin || url.pathname !== login.pathname)) authenticating = false;
      } catch { /* transient browser URL */ }
    });
    await page.goto(auth.loginUrl, { timeout: 15_000, waitUntil: "domcontentloaded", signal: combined });
    const secrets = credentialSecrets(credentials);
    const loginSignals = await discoverSignals(page, secrets);
    await buildLocator(page, auth.usernameField).fill(credentials.username, { timeout: 15_000, signal: combined });
    await buildLocator(page, auth.passwordField).fill(credentials.password, { timeout: 15_000, signal: combined });
    await buildLocator(page, auth.submitControl).click({ timeout: 15_000, signal: combined });
    await page.waitForURL(url => url.origin !== login.origin || url.pathname !== login.pathname, { timeout: 10_000, signal: combined }).catch(() => {});
    if (combined.aborted) return fail(signal?.aborted ? "Discovery cancelled." : "Discovery timed out.");
    const observed = new URL(page.url());
    if (observed.origin === login.origin && observed.pathname === login.pathname) return fail("The page stayed on the login route. Check credentials locally. MFA, CAPTCHA and interactive SSO need an unsupported additional sign-in step.");
    authenticating = false;
    const prefixes = profile.navigation.allowedPathPrefixes;
    if (!profile.navigation.allowedOrigins.includes(observed.origin) || (prefixes.length && !prefixes.some(p => pathWithinPrefix(observed.pathname, p))) || policyBlocked) return fail("Discovery was blocked by the existing navigation or request policy.");
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000, signal: combined });
    await page.locator('h1,h2,[role="heading"],nav[aria-label],main[aria-label],[aria-labelledby]').first().waitFor({ state: "visible", timeout: 3000, signal: combined }).catch(() => {});
    const candidateSignals = (await discoverSignals(page, secrets)).filter(s => !loginSignals.some(l => l.role === s.role && l.name === s.name));
    if (combined.aborted) return fail(signal?.aborted ? "Discovery cancelled." : "Discovery timed out.");
    if (!candidateSignals.length) return fail("No unique named heading or landmark was found beyond the login page. No conditions were saved; this page needs a supported observable signal.");
    // Callback query/hash and userinfo must never reach profile suggestions.
    const observedUrl = observed.origin + observed.pathname;
    if (redactSecrets(decodeURIComponent(observedUrl), secrets) !== decodeURIComponent(observedUrl)) return fail("The observed URL contains sensitive data and cannot be suggested.");
    if (new URL(page.url()).origin + new URL(page.url()).pathname !== observedUrl || policyBlocked) return fail("The page changed during discovery. Review sign-in before trying again.");
    const escaped = observedUrl.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
    return { status: "observed", observedUrl, successUrlPattern: "^" + escaped + "(?:[?#].*)?$", candidateSignals };
  } catch {
    return fail(combined.aborted ? (signal?.aborted ? "Discovery cancelled." : "Discovery timed out.") : "Discovery could not complete. Check the login controls and browser availability; no conditions were saved.");
  } finally {
    clearTimeout(deadline);
    combined.removeEventListener("abort", abort);
    await browser?.close().catch(() => {});
  }
}
