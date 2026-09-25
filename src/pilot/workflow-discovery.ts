import { chromium, type Browser } from "playwright";
import { buildLocator } from "../actions.js";
import { FormLoginBootstrap } from "../auth/session-bootstrap.js";
import { discoverSignals, type AuthDiscoveryCredentials } from "../auth/discovery.js";
import type { Logger } from "../logger.js";
import type { ProjectProfile } from "../profiles/schema.js";
import { credentialSecrets, redactSecrets } from "../redact.js";
import { ActionPolicy } from "../safety/action-policy.js";
import { installRouteGuard } from "../safety/navigation-guard.js";
import { completionPatternFor, discoverStatefulOnPage, inScope, looksStateChanging, type NeedsConfiguration, type SkippedCandidate } from "./stateful-discovery.js";
import type { DeclaredWorkflow } from "./workflow-manifest.js";

export { completionPatternFor, escapeForPattern, validateDiscoveredWorkflow } from "./stateful-discovery.js";
export type { NeedsConfiguration, SkippedCandidate } from "./stateful-discovery.js";

export type WorkflowDiscoveryResult =
  | { status: "observed"; startPathname: string; candidates: DeclaredWorkflow[]; skipped: SkippedCandidate[]; needsConfiguration: NeedsConfiguration[] }
  | { status: "failed"; reason: string };

const MAX_CANDIDATES = 5;
/** List pages probed for search/filter/pagination/detail workflows, per discovery. */
const MAX_STATEFUL_PAGES = 2;
const LOGIN_ACTIONS = 4;

function workflowId(pathname: string): string {
  const slug = pathname.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase().slice(0, 40);
  return `NAV-${slug || "ROOT"}`;
}

/**
 * Read-only workflow discovery after user-controlled authentication. Logs in
 * through the profile's own verified conditions (FormLoginBootstrap, the
 * same code a real run uses), then reads ONLY link names/paths on the
 * landing page and one heading on each candidate destination. No
 * screenshots, traces, page text or storage state are captured; nothing is
 * written to disk here. A destination without a unique visible heading is
 * dropped: a completed click alone is never treated as success. Discovery
 * suggests drafts -- it does not execute or verify workflows.
 */
export async function runWorkflowDiscovery(profile: ProjectProfile, credentials: AuthDiscoveryCredentials, logger: Logger, signal?: AbortSignal): Promise<WorkflowDiscoveryResult> {
  const fail = (reason: string): WorkflowDiscoveryResult => ({ status: "failed", reason });
  const auth = profile.auth;
  if (auth.mode !== "form-login" || !auth.loginUrl) return fail("Workflow discovery needs a form-login profile.");
  if (auth.checksVerified !== true) return fail("Verify the login conditions first (Authentication setup / discovery, then an Authentication only run).");
  if (profile.limits.maxActions < LOGIN_ACTIONS + 2) return fail("The configured action limit cannot cover login plus one observed navigation.");
  const login = new URL(auth.loginUrl);
  if (!profile.navigation.allowedOrigins.includes(login.origin)) return fail("Login URL is outside the approved origin scope.");

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), Math.min(profile.limits.maxDurationMs, 90_000));
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const cancelled = (): WorkflowDiscoveryResult => fail(signal?.aborted ? "Workflow discovery cancelled." : "Workflow discovery timed out.");
  let browser: Browser | undefined;
  const abort = () => { void browser?.close().catch(() => {}); };
  combined.addEventListener("abort", abort, { once: true });
  const quietLogger = logger.child({}, { level: "silent" });
  const secrets = credentialSecrets(credentials);

  try {
    if (combined.aborted) return cancelled();
    browser = await chromium.launch({ headless: true, timeout: 10_000 });
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    const policy = new ActionPolicy(profile);
    let authenticating = true;
    let policyBlocked = false;
    await installRouteGuard(context, profile.navigation.allowedOrigins, quietLogger, () => { policyBlocked = true; },
      (method, pathname, origin, resourceType) => policy.classifyResourceRequest(method, pathname, origin, resourceType, authenticating));
    const page = await context.newPage();
    context.on("page", (popup) => { if (popup !== page) void popup.close().catch(() => {}); });
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });

    const result = await new FormLoginBootstrap().establish(context, page, profile, credentials, quietLogger, combined);
    authenticating = false;
    if (combined.aborted) return cancelled();
    if (result.status !== "success") return fail(`Sign-in did not satisfy the profile's verified conditions (${result.reason}). Nothing was observed or saved.`);
    if (policyBlocked) return fail("Sign-in was blocked by the request policy.");

    const start = new URL(page.url());
    const startPathname = start.pathname;
    let actionsUsed = LOGIN_ACTIONS;
    const startHeadings = new Set((await discoverSignals(page, secrets)).filter((s) => s.role === "heading").map((s) => s.name));

    const links = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).slice(0, 100).map((a) => {
      const anchor = a as HTMLAnchorElement;
      const visible = anchor.getClientRects().length > 0 && getComputedStyle(anchor).visibility !== "hidden";
      return { href: anchor.href, name: (anchor.getAttribute("aria-label") || anchor.textContent || "").replace(/\s+/g, " ").trim(), visible };
    }));

    const skipped: SkippedCandidate[] = [];
    const queued: Array<{ name: string; pathname: string }> = [];
    for (const link of links) {
      if (!link.visible || !link.name || link.name.length > 60) continue;
      if (redactSecrets(link.name, secrets) !== link.name) continue;
      let url: URL;
      try { url = new URL(link.href); } catch { continue; }
      if (url.origin !== start.origin || !inScope(profile, url)) { skipped.push({ name: link.name, reason: "Outside the approved origin or path scope." }); continue; }
      if (url.pathname === startPathname || url.pathname === login.pathname) continue;
      if (looksStateChanging(link.name, url.pathname)) { skipped.push({ name: link.name, reason: "Wording or path suggests a state-changing or session-ending action; outside read-only authorization." }); continue; }
      if (queued.some((q) => q.pathname === url.pathname || q.name === link.name)) continue;
      queued.push({ name: link.name, pathname: url.pathname });
    }

    const candidates: DeclaredWorkflow[] = [];
    const observedAt = new Date().toISOString().slice(0, 10);
    for (const link of queued) {
      if (candidates.length >= MAX_CANDIDATES) { skipped.push({ name: link.name, reason: `Candidate limit (${MAX_CANDIDATES}) reached; not observed.` }); continue; }
      if (actionsUsed + 2 > profile.limits.maxActions) { skipped.push({ name: link.name, reason: "Action limit reached; not observed." }); continue; }
      if (combined.aborted) return cancelled();
      const target = { role: "link", name: link.name };
      const locator = buildLocator(page, target);
      if (await locator.count() !== 1) { skipped.push({ name: link.name, reason: "More than one control has this name; the step would be ambiguous." }); continue; }
      actionsUsed++;
      await locator.click({ timeout: 10_000, signal: combined });
      const reached = await page.waitForURL((u) => u.pathname === link.pathname, { timeout: 10_000, signal: combined }).then(() => true, () => false);
      if (policyBlocked) return fail("A candidate navigation was blocked by the request policy; discovery stopped.");
      if (!reached) {
        skipped.push({ name: link.name, reason: "The click did not reach the linked page." });
      } else {
        await page.locator('h1,h2,[role="heading"]').first().waitFor({ state: "visible", timeout: 3_000, signal: combined }).catch(() => {});
        const heading = (await discoverSignals(page, secrets)).find((s) => s.role === "heading" && !startHeadings.has(s.name));
        if (!heading) skipped.push({ name: link.name, reason: "No unique visible heading on the destination, so completion could not be asserted." });
        else candidates.push(draftWorkflow(start.origin, startPathname, link, heading.name, observedAt));
      }
      actionsUsed++;
      await page.goto(start.href, { timeout: 15_000, waitUntil: "domcontentloaded", signal: combined });
      if (new URL(page.url()).pathname !== startPathname) return fail("The session did not return to the starting page (it may have expired); discovery stopped.");
    }

    // Stateful probes on the pages just observed (each already has a verified heading).
    const needsConfiguration: NeedsConfiguration[] = [];
    const navigationCandidates = [...candidates];
    for (const nav of navigationCandidates.slice(0, MAX_STATEFUL_PAGES)) {
      if (combined.aborted) return cancelled();
      if (actionsUsed + 3 > profile.limits.maxActions) { skipped.push({ name: nav.page, reason: "Action limit reached before search/filter/pagination probes." }); break; }
      const listPath = nav.execution!.steps[0]!.resultingPathname as string;
      const listHeading = nav.execution!.completion.visible.name as string;
      actionsUsed++;
      await page.goto(start.origin + listPath, { timeout: 15_000, waitUntil: "domcontentloaded", signal: combined });
      if (new URL(page.url()).pathname !== listPath) return fail("The session did not stay on an observed page (it may have expired); discovery stopped.");
      const found = await discoverStatefulOnPage({
        page, profile, origin: start.origin, secrets, signal: combined, observedAt,
        spendAction: () => { if (actionsUsed + 1 > profile.limits.maxActions) return false; actionsUsed++; return true; },
        policyBlocked: () => policyBlocked,
      }, listPath, listHeading);
      if (policyBlocked) return fail("A probe was blocked by the request policy; discovery stopped and nothing was saved.");
      candidates.push(...found.candidates);
      skipped.push(...found.skipped);
      needsConfiguration.push(...found.needsConfiguration);
    }

    if (combined.aborted) return cancelled();
    return { status: "observed", startPathname, candidates, skipped, needsConfiguration };
  } catch {
    return combined.aborted ? cancelled() : fail("Workflow discovery could not complete. Nothing was saved.");
  } finally {
    clearTimeout(deadline);
    combined.removeEventListener("abort", abort);
    await browser?.close().catch(() => {});
  }
}

function draftWorkflow(origin: string, startPathname: string, link: { name: string; pathname: string }, heading: string, observedAt: string): DeclaredWorkflow {
  const id = workflowId(link.pathname);
  return {
    id,
    page: startPathname,
    kind: "navigate",
    description: `Open "${link.name}" from ${startPathname} (read-only navigation).`,
    preconditions: `Signed in through the profile's verified login; starting on ${startPathname}.`,
    authorizedActions: `Click the link named "${link.name}" once. No form input and no other controls.`,
    expectedOutcome: `The URL path becomes ${link.pathname} and the heading "${heading}" is visible. Observed once during workflow discovery on ${observedAt} from the page's accessibility tree; not yet executed evidence.`,
    limitations: "Read-only navigation; no reset needed. Asserts the destination URL and one heading only -- it does not verify page data, content correctness or other controls.",
    evidenceRequired: [`workflows/${id}.json with the URL and visible-heading assertion results`],
    execution: {
      steps: [{ pathname: startPathname, resultingPathname: link.pathname, action: { type: "click", target: { role: "link", name: link.name } } }],
      completion: { urlPattern: completionPatternFor(origin, link.pathname), visible: { role: "heading", name: heading } },
    },
  };
}
