import { isDeepStrictEqual } from "node:util";
import type { Page } from "playwright";
import { buildLocator } from "../actions.js";
import { discoverSignals } from "../auth/discovery.js";
import type { ProjectProfile } from "../profiles/schema.js";
import { DESTRUCTIVE_KEYWORDS } from "../qa/heuristics/h11-safe-control.js";
import { redactSecrets } from "../redact.js";
import { DESTRUCTIVE_PATHNAME_RE, pathWithinPrefix } from "../safety/action-policy.js";
import type { ElementTarget } from "../types.js";
import { resultSnapshot } from "./workflow-runtime.js";
import { declaredWorkflowSchema, type DeclaredWorkflow } from "./workflow-manifest.js";

export type SkippedCandidate = { name: string; reason: string };
export type NeedsConfiguration = { page: string; kind: string; reason: string; suggestion: string };
export type StatefulFindings = { candidates: DeclaredWorkflow[]; skipped: SkippedCandidate[]; needsConfiguration: NeedsConfiguration[] };

/** On top of the H11 destructive list: words for money movement, approvals and outbound actions that a read-only authorization never covers. */
export const STATE_CHANGING_WORDS = [...DESTRUCTIVE_KEYWORDS, "send", "withdraw", "deposit", "approve", "invite", "upload", "message", "sign in", "log in", "login", "register", "apply", "submit", "edit", "update", "reset", "new"];
/** A search term no real record should contain; used only to observe whether the application shows an empty-result state. */
export const NO_MATCH_TERM = "zzqx-autoqa-no-match";
const PAGINATION_PREVIOUS = /^(previous|prev|previous page|‹|«)$/i;

export function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

/** The only completion URL pattern a discovered workflow may use: the exact origin + path, any query/fragment. */
export function completionPatternFor(origin: string, pathname: string): string {
  return "^" + escapeForPattern(origin + pathname) + "(?:[?#].*)?$";
}

export function looksStateChanging(name: string, pathname = ""): boolean {
  const text = `${name} ${pathname.replace(/[-_/]/g, " ")}`.toLowerCase();
  return STATE_CHANGING_WORDS.some((word) => new RegExp(`\\b${escapeForPattern(word)}\\b`).test(text)) || (pathname !== "" && DESTRUCTIVE_PATHNAME_RE.test(pathname));
}

export function inScope(profile: ProjectProfile, url: URL): boolean {
  const prefixes = profile.navigation.allowedPathPrefixes;
  return ["http:", "https:"].includes(url.protocol) && profile.navigation.allowedOrigins.includes(url.origin) && (!prefixes.length || prefixes.some((p) => pathWithinPrefix(url.pathname, p)));
}

export function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase().slice(0, 32) || "ROOT";
}

function getFormAllowed(profile: ProjectProfile, endpoint: string): boolean {
  return profile.resources.allowedFormSubmitEndpoints.some((e) => e.method.toLowerCase() === "get" && e.pathname === endpoint);
}

// --- validation ---------------------------------------------------------

const targetLabel = (t: ElementTarget): string => t.name ?? t.label ?? t.text ?? "";

/**
 * Server-side re-validation of a discovered draft before it is saved. Only
 * the shapes discovery itself produces are accepted, each bounded and in
 * scope, with outcome assertions -- anything else a client might submit is
 * rejected, not "cleaned up".
 */
export function validateDiscoveredWorkflow(profile: ProjectProfile, raw: unknown): { ok: true; workflow: DeclaredWorkflow } | { ok: false; reason: string } {
  const parsed = declaredWorkflowSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "Workflow does not match the declared-workflow schema." };
  const workflow = parsed.data;
  const execution = workflow.execution;
  const kind = workflow.kind ?? "navigate";
  if (!execution) return { ok: false, reason: "Only executable drafts can be saved." };
  if (kind === "sort") return { ok: false, reason: "Sort workflows are not supported by discovery." };
  if (!profile.workflows.allowedWorkflowKinds.includes(kind)) return { ok: false, reason: `This profile does not allow "${kind}" workflows (workflows.allowedWorkflowKinds).` };
  const steps = execution.steps;
  if (steps.length > 2) return { ok: false, reason: "Discovered workflows have at most two steps." };
  const origin = new URL(profile.auth.loginUrl ?? profile.target.url).origin;
  const paths = [workflow.page, ...steps.flatMap((s) => [s.pathname, ...(s.resultingPathname ? [s.resultingPathname] : [])]), ...(workflow.reset ? [workflow.reset.pathname] : [])];
  for (const pathname of paths) {
    const url = new URL(pathname, origin);
    if (!inScope(profile, url) || url.pathname !== pathname) return { ok: false, reason: `${pathname} is outside the approved navigation scope.` };
  }
  for (const step of steps) {
    const target = "target" in step.action ? step.action.target : undefined;
    if (!target || !targetLabel(target)) return { ok: false, reason: "Every step must use one named, explicit control." };
    if (looksStateChanging(targetLabel(target), step.resultingPathname ?? "")) return { ok: false, reason: "A control or destination looks state-changing and is outside read-only authorization." };
    if (step.action.type === "fill" && step.action.value.length > 100) return { ok: false, reason: "Search input is limited to 100 characters." };
  }
  const last = steps[steps.length - 1]!;
  const finalPath = last.resultingPathname ?? last.pathname;
  if (execution.completion.urlPattern !== completionPatternFor(origin, finalPath)) return { ok: false, reason: "The completion URL pattern must be the exact observed destination." };
  if (!targetLabel(execution.completion.visible)) return { ok: false, reason: "Completion must assert a named visible element observed during discovery." };
  const stateful = kind !== "navigate";
  if (stateful && !workflow.reset) return { ok: false, reason: "Search, filter and pagination workflows must declare a verified reset to their starting page." };
  if (stateful && (!last.resultingQuery || !isDeepStrictEqual(last.resultingQuery, execution.completion.query))) return { ok: false, reason: "The observed query parameters must be both the step result and a completion assertion." };

  const [a, b] = [steps[0]!.action, steps[1]?.action];
  const shapeOk =
    // Page identity for navigation/detail is a heading observed on the destination.
    kind === "navigate" ? steps.length === 1 && a.type === "click" && a.target.role === "link" && Boolean(steps[0]!.resultingPathname) && execution.completion.visible.role === "heading"
    : kind === "paginate" ? steps.length === 1 && a.type === "click" && a.target.role === "link" && steps[0]!.resultingPathname === steps[0]!.pathname
    : kind === "filter" ? (steps.length === 1 && a.type === "click" && a.target.role === "link" && steps[0]!.resultingPathname === steps[0]!.pathname)
      || (steps.length === 2 && a.type === "select" && b?.type === "click" && b.target.role === "button" && getFormAllowed(profile, finalPath))
    : kind === "search" ? steps.length === 2 && a.type === "fill" && b?.type === "press" && b.key === "Enter" && isDeepStrictEqual(a.target, b.target) && getFormAllowed(profile, finalPath)
    : false;
  if (!shapeOk) return { ok: false, reason: `The steps are not a supported read-only ${kind} workflow for this profile's configuration.` };
  return { ok: true, workflow };
}

// --- discovery on one list page ------------------------------------------

type PageStructure = {
  records: Array<{ name: string; href: string }>;
  container?: ElementTarget;
  rowRole: string;
  filterLinks: Array<{ name: string; href: string }>;
  next?: { name: string; href: string };
  forms: Array<{ action: string; method: string; search?: { label: string; field: string; searchRole: boolean }; select?: { label: string; field: string; options: Array<{ label: string; value: string }> }; submit?: string }>;
};

async function readStructure(page: Page, listPath: string): Promise<PageStructure> {
  return page.evaluate((path) => {
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const nameOf = (el: Element) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
    const labelFor = (el: Element) => {
      const id = el.getAttribute("id");
      const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      return (el.getAttribute("aria-label") || byFor?.textContent || "").replace(/\s+/g, " ").trim();
    };
    const anchors = Array.from(document.querySelectorAll("a[href]")).filter(visible) as HTMLAnchorElement[];
    const records: Array<{ name: string; href: string }> = [];
    let containerEl: Element | null = null;
    for (const a of anchors) {
      const url = new URL(a.href);
      const box = a.closest("table,[role=table],[role=grid],ul,ol,[role=list]");
      if (box && url.origin === location.origin && url.pathname.startsWith(path + "/") && nameOf(a)) {
        records.push({ name: nameOf(a), href: a.href });
        containerEl = containerEl ?? box;
      }
    }
    let container: { role: string; name: string } | undefined;
    let rowRole = "row";
    if (containerEl) {
      const tag = containerEl.tagName;
      const role = containerEl.getAttribute("role") || (tag === "TABLE" ? "table" : tag === "UL" || tag === "OL" ? "list" : "");
      const caption = tag === "TABLE" ? (containerEl as HTMLTableElement).caption?.textContent : null;
      const name = (containerEl.getAttribute("aria-label") || caption || "").replace(/\s+/g, " ").trim();
      if (role && name) container = { role, name };
      rowRole = role === "list" ? "listitem" : "row";
    }
    const filterLinks: Array<{ name: string; href: string }> = [];
    let next: { name: string; href: string } | undefined;
    for (const a of anchors) {
      const url = new URL(a.href);
      if (url.origin !== location.origin || url.pathname !== path || !url.search) continue;
      const name = nameOf(a);
      if (!name) continue;
      if (/^(next|next page|›|»)$/i.test(name)) next = next ?? { name, href: a.href };
      else if (!/^(previous|prev|previous page|‹|«|page\s*\d+|\d+)$/i.test(name)) filterLinks.push({ name, href: a.href });
    }
    const forms = Array.from(document.querySelectorAll("form")).filter(visible).map((form) => {
      const f = form as HTMLFormElement;
      const inputs = Array.from(f.querySelectorAll("input")).filter(visible);
      const searchInput = inputs.find((i) => i.type === "search" || i.getAttribute("role") === "searchbox") ?? inputs.find((i) => (i.type === "text" || !i.type) && /search/i.test(labelFor(i)));
      const select = Array.from(f.querySelectorAll("select")).filter(visible)[0] as HTMLSelectElement | undefined;
      const button = Array.from(f.querySelectorAll("button,input[type=submit]")).filter(visible).find((b) => (b as HTMLButtonElement).type !== "button" && (b as HTMLButtonElement).type !== "reset");
      return {
        action: f.action || location.href,
        method: (f.getAttribute("method") || "get").toLowerCase(),
        ...(searchInput && searchInput.name && labelFor(searchInput) ? { search: { label: labelFor(searchInput), field: searchInput.name, searchRole: searchInput.type === "search" || searchInput.getAttribute("role") === "searchbox" } } : {}),
        ...(select && select.name && labelFor(select) ? { select: { label: labelFor(select), field: select.name, options: Array.from(select.options).map((o) => ({ label: o.label.trim(), value: o.value })).filter((o) => o.value !== "") } } : {}),
        ...(button ? { submit: nameOf(button) || (button as HTMLInputElement).value || "" } : {}),
      };
    });
    return { records: records.slice(0, 25), ...(container ? { container } : {}), rowRole, filterLinks: filterLinks.slice(0, 10), ...(next ? { next } : {}), forms };
  }, listPath);
}

export type StatefulContext = {
  page: Page;
  profile: ProjectProfile;
  origin: string;
  secrets: readonly string[];
  signal: AbortSignal;
  observedAt: string;
  /** Reserves one browser action from the profile's budget; false once exhausted. */
  spendAction(): boolean;
  policyBlocked(): boolean;
};

/**
 * Probes one list page for search, filter, pagination and record-detail
 * workflows. Every draft is backed by something discovery actually did and
 * saw: the resulting URL/query, the observed result-set change, and a
 * visible element. Probes that cannot establish an outcome are reported as
 * skipped; probes the profile has not authorized (GET form endpoints,
 * workflow kinds) are reported as needing configuration and are NOT run.
 * Only counts/verdicts about result sets leave this function -- never the
 * listed values themselves, except the one record name used as a search
 * term / visible assertion, which the user reviews before saving.
 */
export async function discoverStatefulOnPage(ctx: StatefulContext, listPath: string, listHeading: string): Promise<StatefulFindings> {
  const { page, profile, origin, signal } = ctx;
  const out: StatefulFindings = { candidates: [], skipped: [], needsConfiguration: [] };
  const listUrl = origin + listPath;
  const headingTarget: ElementTarget = { role: "heading", name: listHeading };
  const reset = { pathname: listPath, visible: headingTarget };
  const kinds = profile.workflows.allowedWorkflowKinds;

  const backToList = async (): Promise<boolean> => {
    if (!ctx.spendAction()) return false;
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 15_000, signal });
    return new URL(page.url()).pathname === listPath && await buildLocator(page, headingTarget).isVisible().catch(() => false);
  };
  const unique = async (target: ElementTarget) => (await buildLocator(page, target).count().catch(() => 0)) === 1;
  const clean = (name: string) => redactSecrets(name, ctx.secrets) === name && name.length <= 60;

  const structure = await readStructure(page, listPath);
  const within = structure.container;
  const rowRole = structure.rowRole;
  const snapshot = () => resultSnapshot(page, within, rowRole);
  const changedFrom = { ...(within ? { within } : {}), role: rowRole };
  const observed = (summary: string, controls: ElementTarget[]) => ({ observedAt: ctx.observedAt, summary, controls });
  const common = (id: string, kind: DeclaredWorkflow["kind"], description: string) => ({
    id, page: listPath, kind, description,
    preconditions: `Signed in through the profile's verified login; starting on ${listPath} with no search or filter applied.`,
    limitations: "Read-only. Asserts URL, query parameters, one visible element and that the listed results changed -- it does not verify the correctness of listed values, totals or balances.",
    evidenceRequired: [`workflows/${id}.json with every assertion's expected and observed value`],
    reset,
  });

  // Record detail: open the first listed record and observe its own heading.
  const record = structure.records.find((r) => clean(r.name) && !looksStateChanging(r.name, new URL(r.href).pathname));
  if (record) {
    const target = { role: "link", name: record.name };
    const recordPath = new URL(record.href).pathname;
    if (!(await unique(target))) out.skipped.push({ name: record.name, reason: "Record link name is not unique on the page; the step would be ambiguous." });
    else if (!ctx.spendAction()) out.skipped.push({ name: record.name, reason: "Action limit reached; record detail not observed." });
    else {
      await buildLocator(page, target).click({ timeout: 10_000, signal });
      const reached = await page.waitForURL((u) => u.pathname === recordPath, { timeout: 10_000, signal }).then(() => true, () => false);
      const heading = reached ? (await discoverSignals(page, ctx.secrets)).find((s) => s.role === "heading" && s.name !== listHeading) : undefined;
      if (!heading) out.skipped.push({ name: record.name, reason: reached ? "The record page shows no unique heading of its own; identity could not be asserted." : "The record link did not open its detail page." });
      else {
        const id = `DETAIL-${slug(listPath)}`;
        out.candidates.push({
          ...common(id, "navigate", `Open the first listed record from ${listPath} and confirm its detail page identity.`),
          authorizedActions: `Click the record link named "${record.name}" once.`,
          expectedOutcome: `The URL path becomes ${recordPath} and the heading "${heading.name}" identifies that record. Observed once during discovery on ${ctx.observedAt}.`,
          observed: observed(`Clicked the record link; arrived at ${recordPath}; heading "${heading.name}" was visible.`, [target]),
          execution: { steps: [{ pathname: listPath, resultingPathname: recordPath, action: { type: "click", target } }], completion: { urlPattern: completionPatternFor(origin, recordPath), visible: { role: "heading", name: heading.name } } },
        });
      }
      if (!(await backToList())) { out.skipped.push({ name: listPath, reason: "Could not return to the list page; further probes on it were stopped." }); return out; }
    }
  }

  // Link-based filter and pagination: same page, different query.
  const linkProbe = async (link: { name: string; href: string }, kind: "filter" | "paginate") => {
    if (!kinds.includes(kind)) { out.needsConfiguration.push({ page: listPath, kind, reason: `A ${kind === "filter" ? "filter" : "pagination"} link ("${link.name}") was observed but this profile does not allow "${kind}" workflows.`, suggestion: `Add "${kind}" to workflows.allowedWorkflowKinds if it is a read-only operation, then discover again.` }); return; }
    const target = { role: "link", name: link.name };
    const expected = Object.fromEntries(new URL(link.href).searchParams);
    if (!clean(link.name) || looksStateChanging(link.name)) { out.skipped.push({ name: link.name, reason: "Wording suggests a state-changing action." }); return; }
    if (!(await unique(target))) { out.skipped.push({ name: link.name, reason: "Link name is not unique; the step would be ambiguous." }); return; }
    if (!ctx.spendAction()) { out.skipped.push({ name: link.name, reason: "Action limit reached; not observed." }); return; }
    const before = await snapshot();
    await buildLocator(page, target).click({ timeout: 10_000, signal });
    const reached = await page.waitForURL((u) => u.pathname === listPath && Object.entries(expected).every(([k, v]) => u.searchParams.get(k) === v), { timeout: 10_000, signal }).then(() => true, () => false);
    const after = reached ? await snapshot() : before;
    const changed = after.length !== before.length || after.some((v, i) => v !== before[i]);
    const previous = kind === "paginate" && reached ? (await page.getByRole("link").evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()))).find((n) => PAGINATION_PREVIOUS.test(n)) : undefined;
    if (!reached) out.skipped.push({ name: link.name, reason: "The link did not produce the expected query." });
    else if (!changed) out.skipped.push({ name: link.name, reason: "The listed results did not change, so no outcome could be established." });
    else {
      const id = `${kind === "filter" ? "FILTER" : "PAGE"}-${slug(listPath)}-${slug(link.name)}`;
      const visible = previous && await unique({ role: "link", name: previous }) ? { role: "link", name: previous } : headingTarget;
      out.candidates.push({
        ...common(id, kind, kind === "filter" ? `Apply the "${link.name}" filter on ${listPath}.` : `Go to the next page of results on ${listPath}.`),
        authorizedActions: `Click the link named "${link.name}" once.`,
        expectedOutcome: `The query becomes ${JSON.stringify(expected)}, the listed ${rowRole}s change from the starting page, and ${visible.name === listHeading ? `the heading "${listHeading}" stays visible` : `a "${visible.name}" link appears`}. Observed during discovery on ${ctx.observedAt}.`,
        observed: observed(`Clicked "${link.name}"; the query became ${JSON.stringify(expected)} and ${before.length} → ${after.length} ${rowRole}s, set changed.`, [target]),
        execution: { steps: [{ pathname: listPath, resultingPathname: listPath, resultingQuery: expected, action: { type: "click", target } }], completion: { urlPattern: completionPatternFor(origin, listPath), visible, query: expected, changedFrom } },
      });
    }
    await backToList();
  };
  if (structure.filterLinks[0]) await linkProbe(structure.filterLinks[0], "filter");
  if (structure.next) await linkProbe(structure.next, "paginate");

  // GET forms: search box and a native <select> filter.
  for (const form of structure.forms) {
    const endpoint = new URL(form.action).pathname;
    if (form.method !== "get") { out.skipped.push({ name: `form → ${endpoint}`, reason: "Non-GET form; never proposed or submitted by discovery." }); continue; }
    const allowed = getFormAllowed(profile, endpoint);
    const configNote = (kind: string) => `Add {"method":"GET","pathname":"${endpoint}"} to resources.allowedFormSubmitEndpoints${kinds.includes(kind as never) ? "" : ` and "${kind}" to workflows.allowedWorkflowKinds`} only if this form is read-only, then discover again.`;
    if (form.search) {
      if (!allowed || !kinds.includes("search")) out.needsConfiguration.push({ page: listPath, kind: "search", reason: `A search form ("${form.search.label}") submits to GET ${endpoint}, which this profile has not authorized, so it was not submitted.`, suggestion: configNote("search") });
      else await searchProbe(form.search, endpoint);
    }
    if (form.select && form.select.options.length >= 1) {
      if (!allowed || !kinds.includes("filter")) out.needsConfiguration.push({ page: listPath, kind: "filter", reason: `A "${form.select.label}" selector submits to GET ${endpoint}, which this profile has not authorized, so it was not used.`, suggestion: configNote("filter") });
      else if (!form.submit || looksStateChanging(form.submit)) out.skipped.push({ name: form.select.label, reason: "No read-only submit control for this selector." });
      else await selectProbe(form.select, form.submit, endpoint);
    }
  }
  return out;

  async function searchProbe(search: { label: string; field: string; searchRole: boolean }, endpoint: string) {
    const input: ElementTarget = search.searchRole ? { role: "searchbox", name: search.label } : { label: search.label };
    const firstWords = structure.records.map((r) => r.name.split(/\s+/)[0] ?? "").filter((w) => /^[\p{L}\p{N}]{3,}$/u.test(w));
    const chosen = structure.records.find((r) => { const w = r.name.split(/\s+/)[0] ?? ""; return firstWords.filter((x) => x.toLowerCase() === w.toLowerCase()).length === 1 && clean(r.name) && /^[\p{L}\p{N}]{3,}$/u.test(w); });
    if (!chosen) { out.skipped.push({ name: search.label, reason: "No listed record offers a distinctive search term; no outcome could be established." }); return; }
    if (!(await unique(input))) { out.skipped.push({ name: search.label, reason: "Search box is not uniquely identifiable." }); return; }
    const term = chosen.name.split(/\s+/)[0] as string;
    const recordTarget = { role: "link", name: chosen.name };

    const submit = async (value: string): Promise<boolean> => {
      if (!ctx.spendAction() || !ctx.spendAction()) return false;
      await buildLocator(page, input).fill(value, { timeout: 10_000, signal });
      await buildLocator(page, input).press("Enter", { timeout: 10_000, signal });
      return page.waitForURL((u) => u.pathname === endpoint && u.searchParams.get(search.field) === value, { timeout: 10_000, signal }).then(() => true, () => false);
    };
    const before = await snapshot();
    if (!(await submit(term))) { out.skipped.push({ name: search.label, reason: "Submitting the search did not produce the expected query (or the action limit was reached)." }); await backToList(); return; }
    const after = await snapshot();
    const changed = after.length !== before.length || after.some((v, i) => v !== before[i]);
    const found = await buildLocator(page, recordTarget).isVisible().catch(() => false);
    const query = { [search.field]: term };
    if (!changed || !found) out.skipped.push({ name: search.label, reason: `Searching "${term}" did not ${found ? "change the results" : "show the record it came from"}; no outcome could be established.` });
    else {
      const id = `SEARCH-${slug(listPath)}`;
      out.candidates.push({
        ...common(id, "search", `Search ${listPath} for "${term}" and confirm the matching record is listed.`),
        authorizedActions: `Type "${term}" into "${search.label}" and press Enter. No other input.`,
        expectedOutcome: `The query becomes ${JSON.stringify(query)}, the search box keeps "${term}", the results change and "${chosen.name}" is listed. Observed during discovery on ${ctx.observedAt}.`,
        observed: observed(`Searched "${term}" (a word from a listed record); ${before.length} → ${after.length} ${rowRole}s and "${chosen.name}" was listed.`, [input]),
        execution: {
          steps: [
            { pathname: listPath, action: { type: "fill", target: input, value: term } },
            { pathname: listPath, resultingPathname: endpoint, resultingQuery: query, action: { type: "press", target: input, key: "Enter" } },
          ],
          completion: { urlPattern: completionPatternFor(origin, endpoint), visible: recordTarget, query, inputValue: { target: input, equals: term }, changedFrom },
        },
      });
    }
    if (!(await backToList())) return;

    // Empty result: only proposed if the application shows an observable empty-state message.
    if (!(await submit(NO_MATCH_TERM))) { await backToList(); return; }
    const emptyText = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("[role=status], p, div, td, li")).filter((el) => (el as HTMLElement).getClientRects().length > 0 && el.children.length === 0);
      const hit = candidates.map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()).find((t) => t.length > 0 && t.length <= 120 && /\b(no|nothing|0)\b[^.]*\b(match|matches|results?|found|records?|items?|statements?|transactions?)\b/i.test(t));
      return hit ?? null;
    });
    const recordGone = !(await buildLocator(page, recordTarget).isVisible().catch(() => false));
    if (!emptyText || !recordGone || !(await unique({ text: emptyText }))) out.skipped.push({ name: `${search.label} (no matches)`, reason: "No observable empty-result message was shown, so empty-result behavior cannot be asserted." });
    else {
      const id = `SEARCH-EMPTY-${slug(listPath)}`;
      const query = { [search.field]: NO_MATCH_TERM };
      out.candidates.push({
        ...common(id, "search", `Search ${listPath} for a term that matches nothing and confirm the empty-result message.`),
        authorizedActions: `Type "${NO_MATCH_TERM}" into "${search.label}" and press Enter. No other input.`,
        expectedOutcome: `The query becomes ${JSON.stringify(query)}, the message "${emptyText}" is shown and "${chosen.name}" is not listed. Observed during discovery on ${ctx.observedAt}.`,
        observed: observed(`Searched a non-matching term; the page showed "${emptyText}".`, [input]),
        execution: {
          steps: [
            { pathname: listPath, action: { type: "fill", target: input, value: NO_MATCH_TERM } },
            { pathname: listPath, resultingPathname: endpoint, resultingQuery: query, action: { type: "press", target: input, key: "Enter" } },
          ],
          completion: { urlPattern: completionPatternFor(origin, endpoint), visible: { text: emptyText }, query, absent: [recordTarget], ...(within ? { count: { within, role: "link", max: 0 } } : {}) },
        },
      });
    }
    await backToList();
  }

  async function selectProbe(select: { label: string; field: string; options: Array<{ label: string; value: string }> }, submitName: string, endpoint: string) {
    const option = select.options.find((o) => clean(o.label) && !looksStateChanging(o.label));
    if (!option) { out.skipped.push({ name: select.label, reason: "No suitable option." }); return; }
    const selectTarget: ElementTarget = { label: select.label };
    const button: ElementTarget = { role: "button", name: submitName };
    if (!(await unique(selectTarget)) || !(await unique(button))) { out.skipped.push({ name: select.label, reason: "Selector or its submit control is not uniquely identifiable." }); return; }
    if (!ctx.spendAction() || !ctx.spendAction()) { out.skipped.push({ name: select.label, reason: "Action limit reached; not observed." }); return; }
    const before = await snapshot();
    await buildLocator(page, selectTarget).selectOption({ label: option.label }, { timeout: 10_000 });
    await buildLocator(page, button).click({ timeout: 10_000, signal });
    const reached = await page.waitForURL((u) => u.pathname === endpoint && u.searchParams.get(select.field) === option.value, { timeout: 10_000, signal }).then(() => true, () => false);
    const after = reached ? await snapshot() : before;
    const changed = after.length !== before.length || after.some((v, i) => v !== before[i]);
    const value = reached ? await buildLocator(page, selectTarget).inputValue().catch(() => undefined) : undefined;
    if (!reached || !changed || value !== option.value) out.skipped.push({ name: select.label, reason: !reached ? "Choosing the option did not produce the expected query." : !changed ? "The listed results did not change." : "The selector did not keep the chosen value." });
    else {
      const id = `FILTER-${slug(listPath)}-${slug(select.label)}`;
      const query = { [select.field]: option.value };
      out.candidates.push({
        ...common(id, "filter", `Filter ${listPath} by ${select.label} = ${option.label}.`),
        authorizedActions: `Choose "${option.label}" in "${select.label}" and press the "${submitName}" button. No other input.`,
        expectedOutcome: `The query includes ${JSON.stringify(query)}, the selector keeps "${option.label}" and the listed ${rowRole}s change. Observed during discovery on ${ctx.observedAt}.`,
        observed: observed(`Chose "${option.label}"; ${before.length} → ${after.length} ${rowRole}s, set changed; selector kept the value.`, [selectTarget, button]),
        execution: {
          steps: [
            { pathname: listPath, action: { type: "select", target: selectTarget, option: option.label } },
            { pathname: listPath, resultingPathname: endpoint, resultingQuery: query, action: { type: "click", target: button } },
          ],
          completion: { urlPattern: completionPatternFor(origin, endpoint), visible: headingTarget, query, inputValue: { target: selectTarget, equals: option.value }, changedFrom },
        },
      });
    }
    await backToList();
  }
}

