import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Response } from "playwright";
import { acquireBoundedJson } from "../auth/api-observer.js";
import type { ReasonCode } from "../outcomes/outcome.js";
import type { ProjectProfile } from "../profiles/schema.js";
import type { ConsistencyCheck, DeclaredApiCheck } from "./checks-manifest.js";
import { appendCheckLedgerEntry, writeCheckEvidence } from "./evidence.js";
import { createCheckRequester, scopedCheckUrl, sessionFields, type CheckBudget, type RunSession } from "./request-scope.js";
import { getByPath } from "./shape-check.js";

/**
 * UI–API comparison for one declared table and one approved GET check.
 *
 * Two modes, stated in every result:
 * - "rendering-response": the UI is compared with the response the page
 *   itself fetched while rendering that same load (passively read, no
 *   extra request, size-bounded as in the API observer);
 * - "separate-check": the UI is read first, then the approved check is sent.
 *   The two reads happen at different times; this is not an atomic snapshot.
 *
 * Outcomes: pass (every matched record equal); fail (a comparable mismatch
 * that a second observation of BOTH sides reproduced with both sides
 * unchanged); otherwise not assessed with a reason (ambiguous identity,
 * scope, missing field, data changed, not reproduced, authentication,
 * budget, cancellation). Never retried until green. A failed comparison
 * means the declared relation did not hold; it is not by itself a
 * confirmed product defect.
 *
 * Privacy: record keys and values exist only in memory during the
 * comparison. Evidence keeps record positions, API value types, verdicts and
 * reasons; never keys, values, value lengths or rows.
 */
export type RecordValue = { key: string; value: string | undefined; valueType: string };
export type Observation = { records: RecordValue[]; uiRowCount?: number; apiItemCount?: number; readAt: string };
export type Comparison = {
  verdict: "pass" | "mismatch" | "not-assessed";
  reasonCode: ReasonCode;
  detail: string;
  /** Matched records in UI order, as (UI value, API value); in memory only. */
  pairs: Array<{ key: string; ui: string; api: string | undefined }>;
  /** Persisted per record: position, API value type and the verdict only. No lengths (a length can reveal a short value such as a status). */
  sanitized: Array<{ record: number; apiType: string; equal: boolean | null }>;
};

export function normalizeValue(value: string, check: ConsistencyCheck): string {
  let v = value;
  const rules = new Set(check.relation === "status-equal" ? [...check.normalize, "trim", "collapse-whitespace", "case-insensitive"] : check.normalize);
  if (rules.has("collapse-whitespace")) v = v.replace(/\s+/g, " ");
  if (rules.has("trim")) v = v.trim();
  if (rules.has("case-insensitive")) v = v.toLowerCase();
  return v;
}

/** Pure: compares one UI observation with one API observation. */
export function compareObservations(check: ConsistencyCheck, ui: Observation, api: Observation): Comparison {
  const empty = (reasonCode: ReasonCode, detail: string): Comparison => ({ verdict: "not-assessed", reasonCode, detail, pairs: [], sanitized: [] });
  if (check.relation === "count-equal") {
    if (ui.uiRowCount === undefined || api.apiItemCount === undefined) return empty("missing-field", "A row or item count was not available.");
    if (check.scope.pageSize !== undefined && ui.uiRowCount > check.scope.pageSize) return empty("scope-mismatch", `The UI shows more rows than one API page of ${check.scope.pageSize}.`);
    const equal = ui.uiRowCount === api.apiItemCount;
    return { verdict: equal ? "pass" : "mismatch", reasonCode: equal ? "ok" : "assertion-failed", detail: equal ? "Row count on the UI page equals the item count of the same API page." : "Row count on the UI page differs from the item count of the same API page.", pairs: [{ key: "count", ui: String(ui.uiRowCount), api: String(api.apiItemCount) }], sanitized: [{ record: 1, apiType: "count", equal }] };
  }
  const normKey = (k: string) => normalizeValue(k, { ...check, relation: "text-equal" });
  const duplicates = (records: RecordValue[]) => new Set(records.map((r) => normKey(r.key))).size !== records.length;
  if (duplicates(ui.records) || duplicates(api.records)) return empty("ambiguous-identity", "A record key appears more than once on one side, so records cannot be matched unambiguously.");
  const apiByKey = new Map(api.records.map((r) => [normKey(r.key), r]));
  const matched = ui.records.filter((r) => apiByKey.has(normKey(r.key))).slice(0, check.maxRecords);
  if (!matched.length) return empty("ambiguous-identity", "No record appears on both sides; nothing comparable.");
  const pairs = matched.map((r) => ({ key: normKey(r.key), ui: r.value ?? "", api: apiByKey.get(normKey(r.key))!.value }));
  const sanitized = matched.map((r, i) => {
    const a = apiByKey.get(normKey(r.key))!;
    return { record: i + 1, apiType: a.valueType, equal: a.value === undefined ? null : normalizeValue(r.value ?? "", check) === normalizeValue(a.value, check) };
  });
  if (sanitized.some((s) => s.equal === null)) return { verdict: "not-assessed", reasonCode: "missing-field", detail: `The API field "${check.api.valueField}" is missing or not a text, number or boolean value in a matched record.`, pairs, sanitized };
  const differing = sanitized.filter((s) => !s.equal).length;
  return differing
    ? { verdict: "mismatch", reasonCode: "assertion-failed", detail: `${differing} of ${matched.length} matched record(s) differ; values not recorded.`, pairs, sanitized }
    : { verdict: "pass", reasonCode: "ok", detail: `${matched.length} matched record(s) are equal after normalization.`, pairs, sanitized };
}

/** True when either side's value for any matched record changed between the two attempts. */
export function dataChanged(first: Comparison, second: Comparison): boolean {
  if (first.pairs.length !== second.pairs.length) return true;
  return first.pairs.some((p, i) => p.key !== second.pairs[i]!.key || p.ui !== second.pairs[i]!.ui || p.api !== second.pairs[i]!.api);
}

function apiObservation(check: ConsistencyCheck, body: unknown): Observation | { reasonCode: ReasonCode; detail: string } {
  const items = check.api.itemsPath ? getByPath(body, check.api.itemsPath) : body;
  if (!Array.isArray(items)) return { reasonCode: "missing-field", detail: `The API response has no array at "${check.api.itemsPath || "(root)"}".` };
  const records: RecordValue[] = [];
  for (const item of items.slice(0, 200)) {
    if (!item || typeof item !== "object") continue;
    const rawKey = (item as Record<string, unknown>)[check.api.keyField];
    if (typeof rawKey !== "string" && typeof rawKey !== "number") continue;
    const raw = check.api.valueField ? (item as Record<string, unknown>)[check.api.valueField] : undefined;
    const value = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : undefined;
    records.push({ key: String(rawKey), value, valueType: raw === undefined ? "missing" : raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw });
  }
  return { records, apiItemCount: items.length, readAt: new Date().toISOString() };
}

async function uiObservation(page: Page, check: ConsistencyCheck): Promise<Observation | { reasonCode: ReasonCode; detail: string }> {
  const tables = page.getByRole("table", { name: check.ui.table, exact: true });
  try { await tables.first().waitFor({ state: "visible", timeout: 8_000 }); } catch { return { reasonCode: "control-not-found", detail: `No table named "${check.ui.table}" became visible.` }; }
  if (await tables.count() !== 1) return { reasonCode: "ambiguous-identity", detail: `More than one table is named "${check.ui.table}".` };
  try { await tables.locator("tbody tr").first().waitFor({ state: "attached", timeout: 5_000 }); } catch { return { reasonCode: "missing-field", detail: "The table shows no rows to compare." }; }
  const read = await tables.evaluate((el, cols) => {
    const headers = Array.from(el.querySelectorAll("thead th")).map((th) => (th.textContent ?? "").replace(/\s+/g, " ").trim());
    const k = headers.indexOf(cols.key);
    const v = cols.value === null ? -1 : headers.indexOf(cols.value);
    if (k < 0 || (cols.value !== null && v < 0)) return null;
    const rows = Array.from(el.querySelectorAll("tbody tr"));
    return { count: rows.length, rows: rows.slice(0, 200).map((tr) => { const cells = tr.querySelectorAll("td, th"); return [cells[k]?.textContent ?? null, v < 0 ? null : cells[v]?.textContent ?? null]; }) };
  }, { key: check.ui.keyColumn, value: check.ui.valueColumn ?? null });
  if (!read) return { reasonCode: "control-not-found", detail: "The declared column headers were not found in the table." };
  const records: RecordValue[] = read.rows.filter((r) => r[0] !== null).map((r) => ({ key: r[0]!, value: r[1] ?? undefined, valueType: "text" }));
  return { records, uiRowCount: read.count, readAt: new Date().toISOString() };
}

type Attempt = { attempt: number; mode: ConsistencyCheck["mode"]; verdict: Comparison["verdict"]; reasonCode: ReasonCode; detail: string; uiReadAt?: string; apiReadAt?: string; records: Comparison["sanitized"] };

export type ConsistencyContext = {
  profile: ProjectProfile;
  apiChecks: DeclaredApiCheck[];
  workflows: Array<{ id: string; destination: string | undefined; completed: boolean }>;
  page: Page | undefined;
  runDir: string;
  origin: string;
  budget: CheckBudget;
  session?: RunSession;
  abortSignal?: AbortSignal;
  extraSecrets?: readonly string[];
};

const ASSUMPTIONS: Record<ConsistencyCheck["mode"], string> = {
  "rendering-response": "UI compared with the response the page fetched while rendering that load; both come from one page load.",
  "separate-check": "UI read first, then the approved API check was sent separately; the two reads are close in time but are not an atomic snapshot.",
};

/** Runs every declared comparison and records exactly one ledger entry for each. */
export async function runConsistencyChecks(checks: ConsistencyCheck[], ctx: ConsistencyContext): Promise<void> {
  const requester = createCheckRequester(ctx.profile, ctx.origin, ctx.budget, ctx.session);
  for (const check of checks) {
    const attempts: Attempt[] = [];
    const outcome = await runOne(check, ctx, requester, attempts).catch((): { verdict: "not-assessed"; reasonCode: ReasonCode; detail: string } => ({ verdict: "not-assessed", reasonCode: "internal-error", detail: "The comparison stopped because of an internal error; nothing was concluded." }));
    record(check, ctx, attempts, outcome);
  }
}

type Outcome = { verdict: "pass" | "fail" | "not-assessed"; reasonCode: ReasonCode; detail: string };

async function runOne(check: ConsistencyCheck, ctx: ConsistencyContext, requester: ReturnType<typeof createCheckRequester>, attempts: Attempt[]): Promise<Outcome> {
  const api = ctx.apiChecks.find((c) => c.id === check.api.checkId);
  const workflow = ctx.workflows.find((w) => w.id === check.workflowId);
  if (!ctx.page || !ctx.session?.authenticated) return { verdict: "not-assessed", reasonCode: "auth-failed", detail: "No authenticated session was available for this run." };
  if (!api) return { verdict: "not-assessed", reasonCode: "missing-configuration", detail: "The approved API check no longer exists." };
  if (!workflow?.completed || !workflow.destination) return { verdict: "not-assessed", reasonCode: "precondition-failed", detail: `Workflow ${check.workflowId} did not complete in this run, so its page was not shown to be reachable.` };
  if (!scopedCheckUrl(ctx.profile, ctx.origin, workflow.destination) || !scopedCheckUrl(ctx.profile, ctx.origin, api.pathname)) return { verdict: "not-assessed", reasonCode: "scope-rejected", detail: "The page or the API path is outside the approved scope." };

  const observe = async (n: number): Promise<{ comparison: Comparison; uiReadAt?: string; apiReadAt?: string } | Outcome> => {
    if (ctx.abortSignal?.aborted) return { verdict: "not-assessed", reasonCode: "cancelled", detail: "Stop was requested before this observation." };
    const needed = check.mode === "separate-check" ? 2 : 1; // the page load, plus the API request in separate-check mode
    if (ctx.budget.used + needed > ctx.budget.max || Date.now() >= ctx.budget.deadline) return { verdict: "not-assessed", reasonCode: "budget-exhausted", detail: `The request budget did not allow observation ${n}.` };
    ctx.budget.used++;
    const page = ctx.page!;
    const url = new URL(workflow.destination!, ctx.origin).toString();
    let rendering: Promise<Response> | undefined;
    if (check.mode === "rendering-response") {
      const query = api.query ?? {};
      rendering = page.waitForResponse((r) => {
        if (r.request().method() !== "GET") return false;
        let u: URL;
        try { u = new URL(r.url()); } catch { return false; }
        const names = [...new Set(u.searchParams.keys())];
        return u.origin === ctx.origin && u.pathname === api.pathname && names.length === Object.keys(query).length && names.every((k) => u.searchParams.getAll(k).length === 1 && u.searchParams.get(k) === query[k]);
      }, { timeout: 10_000 });
      rendering.catch(() => undefined);
    }
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }); } catch { return { verdict: "not-assessed", reasonCode: ctx.abortSignal?.aborted ? "cancelled" : "transport-error", detail: "The workflow's page could not be opened." }; }
    if (new URL(page.url()).pathname !== new URL(url).pathname) return { verdict: "not-assessed", reasonCode: "session-expired", detail: "Opening the workflow's page did not stay on it (for example, the session ended)." };
    const ui = await uiObservation(page, check);
    if (!("records" in ui)) return { verdict: "not-assessed", ...ui };
    let body: unknown;
    let apiReadAt: string;
    if (rendering) {
      let response: Response;
      try { response = await rendering; } catch { return { verdict: "not-assessed", reasonCode: "precondition-failed", detail: "The page did not request the approved endpoint with the approved parameters while rendering, so there is no rendering response to compare with." }; }
      const acquired = await acquireBoundedJson(response, undefined, () => Boolean(ctx.abortSignal?.aborted));
      if (!acquired.ok) return { verdict: "not-assessed", reasonCode: acquired.reason === "interrupted" ? "cancelled" : "bounds-exceeded", detail: `The rendering response could not be read within the observation bounds (${acquired.reason}).` };
      body = acquired.value;
      apiReadAt = ui.readAt;
    } else {
      const response = await requester(api.pathname, "GET", undefined, ctx.profile.apiChecks.responseSizeCapBytes, ctx.abortSignal, undefined, api.query);
      if ("failed" in response) return { verdict: "not-assessed", reasonCode: response.code, detail: response.reason };
      if (response.status < 200 || response.status >= 300 || response.jsonParseFailed) return { verdict: "not-assessed", reasonCode: "malformed-response", detail: `The API check returned status ${response.status}${response.jsonParseFailed ? " with a body that is not JSON" : ""}; nothing comparable.` };
      body = response.body;
      apiReadAt = new Date().toISOString();
    }
    const apiSide = apiObservation(check, body);
    if (!("records" in apiSide)) return { verdict: "not-assessed", ...apiSide };
    return { comparison: compareObservations(check, ui, apiSide), uiReadAt: ui.readAt, apiReadAt };
  };

  const first = await observe(1);
  if (!("comparison" in first)) { attempts.push({ attempt: 1, mode: check.mode, verdict: "not-assessed", reasonCode: first.reasonCode, detail: first.detail, records: [] }); return first; }
  attempts.push({ attempt: 1, mode: check.mode, verdict: first.comparison.verdict, reasonCode: first.comparison.reasonCode, detail: first.comparison.detail, uiReadAt: first.uiReadAt!, apiReadAt: first.apiReadAt!, records: first.comparison.sanitized });
  if (first.comparison.verdict === "pass") return { verdict: "pass", reasonCode: "ok", detail: first.comparison.detail };
  if (first.comparison.verdict === "not-assessed") return { verdict: "not-assessed", reasonCode: first.comparison.reasonCode, detail: first.comparison.detail };

  // One reproduction of BOTH sides; the initial mismatch is kept whatever happens.
  const second = await observe(2);
  if (!("comparison" in second)) {
    attempts.push({ attempt: 2, mode: check.mode, verdict: "not-assessed", reasonCode: second.reasonCode, detail: second.detail, records: [] });
    return { verdict: "not-assessed", reasonCode: second.reasonCode, detail: `A mismatch was observed once, but it could not be re-observed (${second.detail}); not confirmed.` };
  }
  attempts.push({ attempt: 2, mode: check.mode, verdict: second.comparison.verdict, reasonCode: second.comparison.reasonCode, detail: second.comparison.detail, uiReadAt: second.uiReadAt!, apiReadAt: second.apiReadAt!, records: second.comparison.sanitized });
  if (dataChanged(first.comparison, second.comparison)) return { verdict: "not-assessed", reasonCode: "data-changed", detail: "A compared value changed between the two observations, so the mismatch cannot be attributed to an inconsistency." };
  if (second.comparison.verdict === "mismatch") return { verdict: "fail", reasonCode: "assertion-failed", detail: `${second.comparison.detail} Reproduced on a second observation of both sides with unchanged data.` };
  return { verdict: "not-assessed", reasonCode: "not-reproduced", detail: "The mismatch did not reproduce on a second observation." };
}

function record(check: ConsistencyCheck, ctx: ConsistencyContext, attempts: Attempt[], outcome: Outcome): void {
  const evidenceDir = join(ctx.runDir, "checks", check.id);
  const relationText = check.relation === "count-equal" ? `UI row count on "${check.ui.table}" equals the item count of the same API page` : `UI column "${check.ui.valueColumn}" equals API field "${check.api.valueField}" for records matched by "${check.ui.keyColumn}" = "${check.api.keyField}"`;
  const file = writeCheckEvidence(evidenceDir, "consistency.json", {
    checkId: check.id,
    mode: check.mode,
    assumption: ASSUMPTIONS[check.mode],
    relation: check.relation,
    normalize: check.normalize,
    outcome,
    attempts,
    privacy: "Record keys and values were held in memory only; records are identified by position.",
    interpretation: "A failed comparison means the declared relation did not hold for this observation; it is not by itself a confirmed product defect.",
  }, ctx.extraSecrets ?? []);
  const failedAttempts = attempts.filter((a) => a.verdict === "mismatch").length;
  appendCheckLedgerEntry(ctx.runDir, {
    checkId: check.id,
    kind: "consistency",
    ran: attempts.length > 0,
    classification: outcome.verdict === "pass" ? "passed" : outcome.verdict === "fail" ? "needs_review" : attempts.length ? "informational" : "unsupported",
    reasonCode: outcome.verdict === "pass" ? "ok" : outcome.verdict === "fail" ? "assertion-failed" : outcome.reasonCode,
    ...(attempts.length === 0 ? { blockedReason: outcome.detail } : {}),
    assertion: check.description,
    observation: `${outcome.detail} (${check.mode})`,
    assertionResults: [{
      id: `consistency:${check.relation === "count-equal" ? "count" : check.api.valueField}`,
      assertion: relationText,
      expected: check.relation,
      observed: outcome.detail,
      passed: outcome.verdict === "pass",
      verdict: outcome.verdict === "pass" ? "pass" : outcome.verdict === "fail" ? "fail" : "not-assessed",
      reasonCode: outcome.verdict === "pass" ? "ok" : outcome.verdict === "fail" ? "assertion-failed" : outcome.reasonCode,
      limitations: ASSUMPTIONS[check.mode],
    }],
    ...(failedAttempts ? { attempts: { total: attempts.length, failed: failedAttempts } } : {}),
    evidenceRefs: [`checks/${check.id}/${file}`],
    ...sessionFields(ctx.profile, ctx.session),
  }, ctx.extraSecrets ?? []);
}

/** Saved workflows of this run with their destination page and whether they completed (from the run's own workflow records). */
export function completedWorkflows(runDir: string, manifest: { workflows: Array<{ id: string; execution?: { steps: Array<{ pathname: string; resultingPathname?: string }> } }> } | undefined): ConsistencyContext["workflows"] {
  return (manifest?.workflows ?? []).map((w) => {
    const steps = w.execution?.steps ?? [];
    const last = steps[steps.length - 1];
    let completed = false;
    try { completed = (JSON.parse(readFileSync(join(runDir, "workflows", `${w.id}.json`), "utf-8")) as { status?: string }).status === "completed"; } catch { completed = false; }
    return { id: w.id, destination: last ? last.resultingPathname ?? last.pathname : undefined, completed };
  });
}
