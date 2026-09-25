import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureOptions, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { createLogger } from "../../src/logger.js";
import { NO_MATCH_TERM } from "../../src/pilot/stateful-discovery.js";
import { runWorkflowDiscovery, validateDiscoveredWorkflow } from "../../src/pilot/workflow-discovery.js";
import { saveWorkflowManifest, type DeclaredWorkflow } from "../../src/pilot/workflow-manifest.js";
import { parseProfile, type ProjectProfile } from "../../src/profiles/schema.js";
import { ProfileStore } from "../../src/profiles/store.js";
import { RunManager } from "../../src/run-manager.js";

/**
 * Stateful read-only workflows (search, filter, pagination, record detail)
 * against the synthetic sign-in fixture: discovery drafts, save-time
 * validation, execution with outcome assertions, and the known-failing
 * variants. Every "never submitted/opened" claim is checked against the
 * fixture's own request log.
 */
const credentials = { username: "demo-a", password: "demo-a-synthetic-password" };
let server: AuthFixtureServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

function profileFor(origin: string, opts: { allowSearchEndpoint?: boolean; maxActions?: number } = {}): ProjectProfile {
  return parseProfile({
    schemaVersion: 1, id: "wf", name: "Stateful workflows", target: { url: `${origin}/home`, environmentKind: "owned-sandbox" },
    navigation: { allowedOrigins: [origin], allowedPathPrefixes: ["/"] },
    resources: { allowedApiOrigins: [origin], allowedFormSubmitEndpoints: opts.allowSearchEndpoint === false ? [] : [{ method: "get", pathname: "/statements" }] },
    workflows: { allowedWorkflowKinds: ["navigate", "search", "filter", "paginate"], executionMode: "declared" },
    auth: { mode: "form-login", checksVerified: true, loginUrl: `${origin}/login`, usernameField: { label: "Username" }, passwordField: { label: "Password" }, submitControl: { role: "button", name: "Sign in" }, successUrlPattern: `^${origin.replace(/[.]/g, "\\.")}/home(?:[?#].*)?$`, authenticatedSignal: { role: "heading", name: "Demo Home" }, allowedRequests: [{ origin, method: "POST", pathname: "/session" }] },
    provider: { explorer: { provider: "mock" }, critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 30000 },
    limits: { maxActions: opts.maxActions ?? 60, maxModelCalls: 60, maxPages: 10, maxFindings: 5, maxDurationMs: 120000, maxCriticCalls: 5 },
  });
}

async function discover(options: AuthFixtureOptions = {}, profileOptions: Parameters<typeof profileFor>[1] = {}) {
  server = await startAuthFixtureServer(options);
  const profile = profileFor(server.origin, profileOptions);
  const result = await runWorkflowDiscovery(profile, credentials, createLogger());
  if (result.status !== "observed") throw new Error(`discovery failed: ${result.reason}`);
  return { profile, result, server };
}

async function execute(profile: ProjectProfile, workflows: DeclaredWorkflow[], abortAfterFirstWorkflow = false) {
  const root = mkdtempSync(join(tmpdir(), "autoqa-stateful-run-"));
  const profiles = join(root, "profiles"); mkdirSync(profiles);
  writeFileSync(join(profiles, "wf.json"), JSON.stringify(profile));
  saveWorkflowManifest(profiles, "wf", workflows);
  const manager = new RunManager(new ProfileStore(profiles), join(root, "runs"));
  const { runId } = await manager.startRun({ profileId: "wf", mode: "demo", credentials });
  if (abortAfterFirstWorkflow) {
    manager.subscribe(runId, (e) => { if (e.detail.startsWith("→")) manager.stopRun(runId); });
  }
  const deadline = Date.now() + 120_000;
  while (manager.getActiveRun() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const dir = join(root, "runs", runId);
  const outcome = (id: string) => JSON.parse(readFileSync(join(dir, "workflows", `${id}.json`), "utf-8")) as { status: string; reason: string; evidence: { failureKind?: string | null; reproduced?: boolean | null; attempts?: number; assertion?: { passed: boolean; assertions: Array<{ assertion: string; expected: string; observed: string; passed: boolean }> }; reset?: { passed: boolean } } };
  return { dir, outcome, summary: JSON.parse(readFileSync(join(dir, "run-summary.json"), "utf-8")) as { status: string } };
}

const byId = (list: DeclaredWorkflow[]) => new Map(list.map((w) => [w.id, w]));

describe("stateful read-only workflow discovery", () => {
  it("drafts search, empty-search, link filter, select filter, pagination and detail workflows, each backed by an observed outcome", async () => {
    const { profile, result } = await discover();
    const ids = byId(result.candidates);
    for (const id of ["SEARCH-STATEMENTS", "SEARCH-EMPTY-STATEMENTS", "FILTER-STATEMENTS-PAID-ONLY", "FILTER-STATEMENTS-STATUS", "PAGE-STATEMENTS-NEXT", "DETAIL-STATEMENTS"]) {
      expect(ids.has(id), `${id} drafted (have: ${[...ids.keys()].join(", ")})`).toBe(true);
      expect(validateDiscoveredWorkflow(profile, ids.get(id)).ok, `${id} validates`).toBe(true);
      expect(ids.get(id)!.reset).toEqual({ pathname: "/statements", visible: { role: "heading", name: "Statements" } });
      expect(ids.get(id)!.observed?.summary.length).toBeGreaterThan(0);
    }
    const search = ids.get("SEARCH-STATEMENTS")!;
    expect(search.execution!.completion.query).toEqual({ q: "Coffee" });
    expect(search.execution!.completion.inputValue).toEqual({ target: { role: "searchbox", name: "Search statements" }, equals: "Coffee" });
    expect(search.execution!.completion.changedFrom).toEqual({ within: { role: "table", name: "Statement results" }, role: "row" });
    expect(ids.get("SEARCH-EMPTY-STATEMENTS")!.execution!.completion.visible).toEqual({ text: "No statements match your search." });
    expect(ids.get("DETAIL-STATEMENTS")!.execution!.completion.visible).toEqual({ role: "heading", name: "Statement st-01" });
    expect(ids.get("PAGE-STATEMENTS-NEXT")!.execution!.completion.visible).toEqual({ role: "link", name: "Previous" });
    expect(result.needsConfiguration).toEqual([]);
  }, 90_000);

  it("does not submit a GET form the profile has not authorized; it reports what configuration is needed instead", async () => {
    const { result, server: fixture } = await discover({}, { allowSearchEndpoint: false });
    expect(result.candidates.some((w) => w.kind === "search")).toBe(false);
    expect(result.candidates.some((w) => w.id === "FILTER-STATEMENTS-STATUS")).toBe(false);
    expect(result.needsConfiguration.map((n) => n.kind).sort()).toEqual(["filter", "search"]);
    expect(result.needsConfiguration[0]!.suggestion).toContain('{"method":"GET","pathname":"/statements"}');
    expect(fixture.requestLog.some((r) => /[?&](q|status)=/.test(r) && !r.includes("status=paid") && !r.includes("status=pending"))).toBe(false);
    expect(fixture.requestLog.some((r) => r.includes(NO_MATCH_TERM))).toBe(false);
    // Link-based filter and pagination need no form submission and are still offered.
    expect(result.candidates.some((w) => w.kind === "filter" && w.id === "FILTER-STATEMENTS-PAID-ONLY")).toBe(true);
  }, 90_000);

  it("rejects stateful drafts whose form endpoint is not authorized, or that lack a reset or a query assertion", async () => {
    const { profile, result } = await discover();
    const search = structuredClone(byId(result.candidates).get("SEARCH-STATEMENTS")!);
    const unauthorized = { ...profile, resources: { ...profile.resources, allowedFormSubmitEndpoints: [] } };
    expect(validateDiscoveredWorkflow(unauthorized, search).ok).toBe(false);
    const noReset = structuredClone(search); delete noReset.reset;
    expect(validateDiscoveredWorkflow(profile, noReset).ok).toBe(false);
    const noQuery = structuredClone(search); delete noQuery.execution!.completion.query;
    expect(validateDiscoveredWorkflow(profile, noQuery).ok).toBe(false);
    const longValue = structuredClone(search); (longValue.execution!.steps[0]!.action as { value: string }).value = "x".repeat(101);
    expect(validateDiscoveredWorkflow(profile, longValue).ok).toBe(false);
  }, 90_000);

  it("executes every discovered workflow to 'completed' with per-assertion evidence and verified resets", async () => {
    const { profile, result } = await discover();
    const { outcome, summary } = await execute(profile, result.candidates);
    expect(summary.status).toBe("completed");
    for (const workflow of result.candidates) {
      const o = outcome(workflow.id);
      expect(o.status, `${workflow.id}: ${o.reason}`).toBe("completed");
      expect(o.evidence.assertion!.assertions.every((a) => a.passed)).toBe(true);
      if (workflow.reset) expect(o.evidence.reset?.passed).toBe(true);
    }
    const search = outcome("SEARCH-STATEMENTS").evidence.assertion!.assertions.map((a) => a.assertion);
    expect(search).toEqual(expect.arrayContaining(['Query parameter "q"', "row results differ from the starting page"]));
  }, 150_000);

  it("reports known application bugs as reproduced assertion mismatches with expected vs observed values", async () => {
    const { profile, result, server: fixture } = await discover();
    fixture.setBugs({ searchIgnoresQuery: true, detailWrongHeading: true });
    const ids = byId(result.candidates);
    const { outcome } = await execute(profile, [ids.get("SEARCH-STATEMENTS")!, ids.get("DETAIL-STATEMENTS")!, ids.get("FILTER-STATEMENTS-PAID-ONLY")!]);
    const search = outcome("SEARCH-STATEMENTS");
    expect(search.status).toBe("failed");
    expect(search.evidence).toMatchObject({ failureKind: "application-assertion", reproduced: true, attempts: 2 });
    const changed = search.evidence.assertion!.assertions.find((a) => a.assertion.includes("differ"))!;
    expect(changed).toMatchObject({ passed: false });
    expect(changed.observed).toContain("unchanged");
    const detail = outcome("DETAIL-STATEMENTS");
    expect(detail.status).toBe("failed");
    expect(detail.evidence.assertion!.assertions.find((a) => a.assertion === "Element visible")).toMatchObject({ expected: "heading Statement st-01", observed: "not visible", passed: false });
    // An unaffected workflow in the same run still completes.
    expect(outcome("FILTER-STATEMENTS-PAID-ONLY").status).toBe("completed");
  }, 150_000);

  it("records a stale control as an AutoQA/configuration blocker, not an application finding", async () => {
    const { profile, result } = await discover();
    const stale = structuredClone(byId(result.candidates).get("FILTER-STATEMENTS-PAID-ONLY")!);
    (stale.execution!.steps[0]!.action as { target: { name: string } }).target.name = "Paid (renamed)";
    const { outcome } = await execute(profile, [stale]);
    expect(outcome(stale.id)).toMatchObject({ status: "blocked", evidence: { failureKind: "autoqa-control" } });
  }, 150_000);

  it("blocks later workflows when a reset to the known starting state cannot be verified", async () => {
    const { profile, result } = await discover();
    const ids = byId(result.candidates);
    const brokenReset = structuredClone(ids.get("FILTER-STATEMENTS-PAID-ONLY")!);
    brokenReset.reset = { pathname: "/statements", visible: { role: "heading", name: "Heading that does not exist" } };
    const { outcome } = await execute(profile, [brokenReset, ids.get("PAGE-STATEMENTS-NEXT")!]);
    expect(outcome(brokenReset.id).evidence.reset?.passed).toBe(false);
    expect(outcome("PAGE-STATEMENTS-NEXT")).toMatchObject({ status: "blocked", evidence: { failureKind: "reset" } });
  }, 150_000);

  it("stops a workflow when the session expires mid-workflow, without calling it an application failure", async () => {
    const { profile, result, server: fixture } = await discover();
    // Views: post-login /home, the run's initial /home, the workflow start /statements; the filter click is the 4th and is refused.
    fixture.setBugs({ sessionMaxPageViews: 3 });
    const { outcome } = await execute(profile, [byId(result.candidates).get("FILTER-STATEMENTS-PAID-ONLY")!]);
    const o = outcome("FILTER-STATEMENTS-PAID-ONLY");
    expect(o).toMatchObject({ status: "blocked", evidence: { failureKind: "session-expired" } });
    expect(o.reason).toContain("SESSION_EXPIRED");
  }, 150_000);

  it("classifies a workflow that never started because the session had already expired", async () => {
    const { profile, result, server: fixture } = await discover();
    fixture.setBugs({ sessionMaxPageViews: 2 }); // expires on the way to the workflow's start page
    const { outcome } = await execute(profile, [byId(result.candidates).get("FILTER-STATEMENTS-PAID-ONLY")!]);
    expect(outcome("FILTER-STATEMENTS-PAID-ONLY")).toMatchObject({ status: "blocked", evidence: { failureKind: "session-expired" } });
  }, 150_000);

  it("Stop during workflow execution cancels the run and records the workflow as cancelled", async () => {
    const { profile, result } = await discover();
    const ids = byId(result.candidates);
    const { outcome, summary } = await execute(profile, [ids.get("SEARCH-STATEMENTS")!, ids.get("PAGE-STATEMENTS-NEXT")!], true);
    expect(summary.status).toBe("cancelled");
    const first = outcome("SEARCH-STATEMENTS");
    expect(first.status).toBe("blocked");
    expect(["cancelled", undefined]).toContain(first.evidence.failureKind ?? undefined);
  }, 150_000);

  it("reports budget exhaustion honestly instead of claiming the remaining workflows passed", async () => {
    const { result, server: fixture } = await discover();
    const tight = profileFor(fixture.origin, { maxActions: 7 });
    const { outcome } = await execute(tight, result.candidates.filter((w) => w.kind !== "navigate"));
    const statuses = result.candidates.filter((w) => w.kind !== "navigate").map((w) => outcome(w.id));
    expect(statuses.some((o) => o.status === "completed")).toBe(true);
    expect(statuses.some((o) => o.status === "blocked" && /budget|BUDGET/.test(o.reason))).toBe(true);
  }, 150_000);

  it("stops discovery promptly when cancelled and returns nothing", async () => {
    server = await startAuthFixtureServer();
    const controller = new AbortController();
    const profile = profileFor(server.origin);
    setTimeout(() => controller.abort(), 1500);
    const started = Date.now();
    const result = await runWorkflowDiscovery(profile, credentials, createLogger(), controller.signal);
    expect(result).toEqual({ status: "failed", reason: "Workflow discovery cancelled." });
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 30_000);
});
