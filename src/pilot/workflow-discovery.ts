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
import pino from "pino";

/** A request the policy denied during discovery: never sent; method, path and reason only. */
export type BlockedRequest = { method: string; pathname: string; reason: string };

export { completionPatternFor, escapeForPattern, validateDiscoveredWorkflow } from "./stateful-discovery.js";
export type { NeedsConfiguration, SkippedCandidate } from "./stateful-discovery.js";

export type WorkflowDiscoveryResult =
  | { status: "observed"; startPathname: string; candidates: DeclaredWorkflow[]; skipped: SkippedCandidate[]; needsConfiguration: NeedsConfiguration[]; blockedRequests: BlockedRequest[] }
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
    // Every request the policy denies is aborted (never sent). It is recorded here as method,
    // path and reason only, so the person can see what the application tried; a denial sets
    // aside only the probe it happened in instead of discarding the whole discovery.
    const blockedRequests: BlockedRequest[] = [];
    let blockedCount = 0;
    const guardLogger = pino({ level: "warn" }, { write: (line: string) => {
      try {
        const entry = JSON.parse(line) as { url?: string; method?: string; reason?: string };
        if (!entry.url || !entry.method) return;
        const pathname = new URL(entry.url).pathname.slice(0, 120);
        const reason = String(entry.reason ?? "").replace(/^ACTION_POLICY_DENIED:\s*/, "").slice(0, 200);
        if (!blockedRequests.some((b) => b.method === entry.method && b.pathname === pathname && b.reason === reason)) blockedRequests.push({ method: entry.method, pathname, reason });
      } catch { /* not a denial record */ }
    } });
    const blockedSince = (count: number): boolean => blockedCount > count;
    const describeBlocked = () => blockedRequests.slice(-3).map((b) => `${b.method} ${b.pathname} (${b.reason})`).join("; ");
    await installRouteGuard(context, profile.navigation.allowedOrigins, guardLogger, () => { blockedCount++; },
      (method, pathname, origin, resourceType) => policy.classifyResourceRequest(method, pathname, origin, resourceType, authenticating));
    const page = await context.newPage();
    context.on("page", (popup) => { if (popup !== page) void popup.close().catch(() => {}); });
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });

    const result = await new FormLoginBootstrap().establish(context, page, profile, credentials, quietLogger, combined);
    authenticating = false;
    if (combined.aborted) return cancelled();
    if (result.status !== "success") return fail(signInFailureMessage(result.reason));
    if (blockedCount > 0) return fail(`Sign-in was blocked by the request policy: ${describeBlocked()}.`);

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
      // One draft per destination; the same link text may lead to several in-scope pages (each is pinned to its path below).
      if (queued.some((q) => q.pathname === url.pathname)) continue;
      queued.push({ name: link.name, pathname: url.pathname });
    }

    const candidates: DeclaredWorkflow[] = [];
    const observedAt = new Date().toISOString().slice(0, 10);
    for (const link of queued) {
      if (candidates.length >= MAX_CANDIDATES) { skipped.push({ name: link.name, reason: `Candidate limit (${MAX_CANDIDATES}) reached; not observed.` }); continue; }
      if (actionsUsed + 2 > profile.limits.maxActions) { skipped.push({ name: link.name, reason: "Action limit reached; not observed." }); continue; }
      if (combined.aborted) return cancelled();
      // Client-rendered apps (e.g. the Ajeer sandbox) draw their menu after the document loads:
      // wait for a link to this destination before judging that it is missing or ambiguous.
      await page.waitForFunction((pathname) => Array.from(document.querySelectorAll("a[href]")).some((a) => { try { return new URL((a as HTMLAnchorElement).href).pathname === pathname; } catch { return false; } }), link.pathname, { timeout: 10_000, polling: 200 }).catch(() => {});
      if (combined.aborted) return cancelled();
      let target: { role: string; name: string; pathname?: string } = { role: "link", name: link.name };
      let locator = buildLocator(page, target);
      const matches = await locator.count();
      if (matches !== 1) {
        // Either the text appears on several controls (sidebar, dashboard shortcut, mobile menu...)
        // or the anchor is not exposed with the link role (e.g. a menu item). Text + exact
        // destination identifies the anchor: the step can only click an anchor that goes to this
        // page, and completion then asserts arrival there.
        target = { role: "link", name: link.name, pathname: link.pathname };
        locator = buildLocator(page, target);
        if (await locator.count() < 1) {
          // Record what was actually on the page for this destination (menu markup only: href, text, role, size).
          const seen = await page.evaluate((pathname) => Array.from(document.querySelectorAll("a[href]")).filter((a) => { try { return new URL((a as HTMLAnchorElement).href).pathname === pathname; } catch { return false; } }).slice(0, 4).map((a) => {
            const r = a.getBoundingClientRect();
            return `href="${(a.getAttribute("href") ?? "").slice(0, 80)}" text="${(a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}"${a.getAttribute("aria-label") ? ` aria-label="${a.getAttribute("aria-label")!.slice(0, 40)}"` : ""}${a.getAttribute("role") ? ` role=${a.getAttribute("role")}` : ""} size=${Math.round(r.width)}x${Math.round(r.height)}`;
          }), link.pathname).catch(() => [] as string[]);
          skipped.push({ name: link.name, reason: `${matches > 1 ? "More than one control has this name" : "No control is exposed as a link with this name"}, and no visible anchor with this text leads to ${link.pathname}; the step would be ambiguous. Observed anchors for that page: ${seen.join(" | ") || "none"}.` });
          continue;
        }
      }
      actionsUsed++;
      const blockedBefore = blockedCount;
      await locator.click({ timeout: 10_000, signal: combined });
      const reached = await page.waitForURL((u) => u.pathname === link.pathname, { timeout: 10_000, signal: combined }).then(() => true, () => false);
      if (!reached) {
        skipped.push({ name: link.name, reason: "The click did not reach the linked page." });
      } else {
        await page.locator('h1,h2,[role="heading"]').first().waitFor({ state: "visible", timeout: 3_000, signal: combined }).catch(() => {});
        const headings = (await discoverSignals(page, secrets)).filter((s) => s.role === "heading" && !startHeadings.has(s.name));
        // Only a heading that relates to the link text is used. On the Ajeer sandbox the first new
        // heading on /account was the member's own name: account-specific personal data, and
        // brittle for any other test account. An unrelated heading is never recorded or echoed.
        const heading = headings.find((h) => relatesTo(h.name, link.name));
        if (!headings.length) skipped.push({ name: link.name, reason: "No unique visible heading on the destination, so completion could not be asserted." });
        else if (!heading) skipped.push({ name: link.name, reason: "No heading on the destination relates to the link text; the headings present may be account-specific (not recorded), so no stable completion could be asserted." });
        else {
          const draft = draftWorkflow(start.origin, startPathname, link, heading.name, observedAt, Boolean(target.pathname));
          // The page loaded and showed its heading; background requests it made that the policy blocked
          // (never sent) are stated, because a run will report them as network-policy blocks.
          if (blockedSince(blockedBefore)) draft.limitations = `${draft.limitations} While this page loaded, the application also made request(s) the read-only policy blocked (never sent): ${describeBlocked()}. A run reports these as network-policy blocks.`;
          candidates.push(draft);
        }
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
      const probeBlockedBefore = blockedCount;
      await page.goto(start.origin + listPath, { timeout: 15_000, waitUntil: "domcontentloaded", signal: combined });
      if (new URL(page.url()).pathname !== listPath) return fail("The session did not stay on an observed page (it may have expired); discovery stopped.");
      const found = await discoverStatefulOnPage({
        page, profile, origin: start.origin, secrets, signal: combined, observedAt,
        spendAction: () => { if (actionsUsed + 1 > profile.limits.maxActions) return false; actionsUsed++; return true; },
        policyBlocked: () => blockedSince(probeBlockedBefore),
      }, listPath, listHeading);
      if (blockedSince(probeBlockedBefore)) {
        // The drafts from this page are not trusted: something the probes did (or the page did meanwhile) was blocked.
        skipped.push({ name: listPath, reason: `Search/filter/pagination probes on ${listPath} were set aside: the application made request(s) the policy blocked (${describeBlocked()}). Navigation drafts are unaffected.` });
        skipped.push(...found.skipped);
        needsConfiguration.push(...found.needsConfiguration);
        continue;
      }
      candidates.push(...found.candidates);
      skipped.push(...found.skipped);
      needsConfiguration.push(...found.needsConfiguration);
    }

    if (combined.aborted) return cancelled();
    return { status: "observed", startPathname, candidates, skipped, needsConfiguration, blockedRequests };
  } catch {
    return combined.aborted ? cancelled() : fail("Workflow discovery could not complete. Nothing was saved.");
  } finally {
    clearTimeout(deadline);
    combined.removeEventListener("abort", abort);
    await browser?.close().catch(() => {});
  }
}

function draftWorkflow(origin: string, startPathname: string, link: { name: string; pathname: string }, heading: string, observedAt: string, pinned = false): DeclaredWorkflow {
  const id = workflowId(link.pathname);
  return {
    id,
    page: startPathname,
    kind: "navigate",
    description: `Open "${link.name}" from ${startPathname} (read-only navigation).`,
    preconditions: `Signed in through the profile's verified login; starting on ${startPathname}.`,
    authorizedActions: `Click the link named "${link.name}"${pinned ? ` that leads to ${link.pathname} (the page shows this link text more than once; the step is pinned to this destination)` : ""} once. No form input and no other controls.`,
    expectedOutcome: `The URL path becomes ${link.pathname} and the heading "${heading}" is visible. Observed once during workflow discovery on ${observedAt} from the page's accessibility tree; not yet executed evidence.`,
    limitations: "Read-only navigation; no reset needed. Asserts the destination URL and one heading only -- it does not verify page data, content correctness or other controls.",
    evidenceRequired: [`workflows/${id}.json with the URL and visible-heading assertion results`],
    execution: {
      steps: [{ pathname: startPathname, resultingPathname: link.pathname, action: { type: "click", target: { role: "link", name: link.name, ...(pinned ? { pathname: link.pathname } : {}) } } }],
      completion: { urlPattern: completionPatternFor(origin, link.pathname), visible: { role: "heading", name: heading } },
    },
  };
}

/** Plain-language sign-in failures for the person at the keyboard; the structured reason stays in brackets. */
export function signInFailureMessage(reason: string): string {
  const hint: Record<string, string> = {
    "stayed-on-login": "The page stayed on the login screen after submitting, so the username or password was most likely rejected. Check both (if you recently changed the password, use the new one). AutoQA did not retry, to avoid locking the account.",
    "success-url-mismatch": "After signing in, the application went to a different page than the one recorded as the signed-in page (for example a password-change, verification or consent screen). Complete that step in a normal browser, or re-run 1c to record the new signed-in page.",
    "missing-signal": "The signed-in page opened, but the recorded heading was not visible. The page may have changed; re-run 1c to record a current signal.",
    "timeout": "The login page or one of its controls did not respond in time.",
    "invalid-credentials": "No username or password was supplied.",
  };
  return `Sign-in did not succeed (${reason}). ${hint[reason] ?? "The profile's verified sign-in conditions were not met."} Nothing was observed or saved.`;
}

/** True when the heading and the link text share a significant word (compared by their first five letters). */
export function relatesTo(heading: string, linkText: string): boolean {
  const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4).map((w) => w.slice(0, 5));
  const linkWords = new Set(words(linkText));
  return words(heading).some((w) => linkWords.has(w));
}
