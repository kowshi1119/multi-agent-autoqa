import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { ProfileStore } from "../../src/profiles/store.js";
import { buildQaSummary, type QaSummary, type QaSummaryContext } from "../../src/reporting/qa-summary.js";
import { RunManager } from "../../src/run-manager.js";

const context: QaSummaryContext = {
  runId: "RUN-TEST",
  application: { profileId: "demo", name: "Demo", origin: "http://localhost:4000", environmentKind: "owned-sandbox", fingerprint: "abcdef012345" },
  operation: "declared-workflows",
  authRequired: true,
  apiChecksUseRunSession: true,
};

const workflow = (id: string) => ({
  id, page: "/statements", kind: "search", description: `Workflow ${id}`, preconditions: "p", authorizedActions: "a", expectedOutcome: "e",
  execution: {
    steps: [
      { pathname: "/statements", action: { type: "fill", target: { role: "searchbox", name: "Search statements" }, value: "coffee" } },
      { pathname: "/statements", resultingPathname: "/statements", resultingQuery: { q: "coffee" }, action: { type: "press", target: { role: "searchbox", name: "Search statements" }, key: "Enter" } },
    ],
    completion: { urlPattern: "^http://localhost:4000/statements\\?q=coffee$", visible: { role: "heading", name: "Statements" } },
  },
});

function runDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "autoqa-qa-summary-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(content));
  }
  return dir;
}

const runSummary = (extra: Record<string, unknown> = {}) => ({ runId: "RUN-TEST", status: "completed", provider: "mock", actionsPerformed: 7, modelCalls: 3, usage: { explorer: { requests: 0, tokenUsage: null }, critic: { requests: 0, tokenUsage: null } }, ...extra });
const mismatch = { assertion: "Query parameter q", expected: "coffee", observed: "(absent)", passed: false };

describe("qa-summary: a run that executed nothing is never a pass", () => {
  it("authentication-only run: verified sign-in, zero checks, explicitly not a QA pass", () => {
    const dir = runDir({ "run-summary.json": runSummary({ actionsPerformed: 3 }), "authentication.json": { status: "success" } });
    const summary = buildQaSummary(dir, { ...context, operation: "authentication-only" });
    expect(summary.verdict.kind).toBe("no-checks-executed");
    expect(summary.verdict.message).toContain("this is not a QA pass");
    expect(summary.authentication.state).toBe("verified");
    expect(summary.apiAuthentication.state).toBe("not-run");
  });

  it("declared workflows that were all blocked or cancelled: no-checks-executed, each listed as not assessed", () => {
    const dir = runDir({
      "run-summary.json": runSummary({ status: "cancelled", stopReason: "CANCELLED: stop requested" }),
      "authentication.json": { status: "success" },
      "workflow-manifest.json": { schemaVersion: 1, profileId: "demo", pages: ["/statements"], workflows: [workflow("A"), workflow("B")] },
      "workflows/A.json": { workflowId: "A", status: "blocked", reason: "Declared control not found", evidence: { failureKind: "autoqa-control" } },
      "workflows/B.json": { workflowId: "B", status: "blocked", reason: "Cancelled", evidence: { failureKind: "cancelled" } },
    });
    const summary = buildQaSummary(dir, context);
    expect(summary.verdict).toMatchObject({ kind: "no-checks-executed", executedChecks: 0, notExecuted: 2 });
    expect(summary.workflows).toMatchObject({ selected: 2, attempted: 2, blocked: 1, cancelled: 1, completed: 0 });
    expect(summary.findings.applicationCandidates).toHaveLength(0);
    expect(summary.findings.autoqaFailures).toEqual([{ source: "workflow", id: "A", kind: "autoqa-control", reason: "Declared control not found" }]);
    expect(summary.notAssessed).toEqual(expect.arrayContaining(["Workflow A: autoqa-control", "Workflow B: cancelled"]));
  });

  it("failed login: authentication failed, nothing executed", () => {
    const dir = runDir({ "run-summary.json": runSummary({ status: "failed" }), "authentication.json": { status: "failed", reason: "Signal not visible" } });
    const summary = buildQaSummary(dir, context);
    expect(summary.authentication).toEqual({ state: "failed", detail: "Signal not visible" });
    expect(summary.verdict.kind).toBe("no-checks-executed");
  });
});

describe("qa-summary: findings are separated and reasoned", () => {
  it("a reproduced mismatch is a provisional application candidate; config failures and unsupported checks are not", () => {
    const dir = runDir({
      "run-summary.json": runSummary(),
      "authentication.json": { status: "success" },
      "workflow-manifest.json": { schemaVersion: 1, profileId: "demo", pages: ["/statements"], workflows: [workflow("SEARCH"), workflow("FLAKY"), workflow("OK"), workflow("GONE")] },
      "workflows/SEARCH.json": { workflowId: "SEARCH", status: "failed", reason: "Assertion mismatch reproduced", evidence: { failureKind: "application-assertion", reproduced: true, attempts: 2, assertion: { passed: false, assertions: [mismatch] }, firstAttempt: { passed: false, assertions: [mismatch] } } },
      "workflows/FLAKY.json": { workflowId: "FLAKY", status: "failed", reason: "Intermittent", evidence: { failureKind: "application-assertion", reproduced: false, attempts: 2, assertion: { passed: true, assertions: [{ ...mismatch, observed: "coffee", passed: true }] }, firstAttempt: { passed: false, assertions: [mismatch] } } },
      "workflows/OK.json": { workflowId: "OK", status: "completed", reason: "passed", evidence: { failureKind: null, attempts: 1, assertion: { passed: true, assertions: [] } } },
      "workflows/GONE.json": { workflowId: "GONE", status: "blocked", reason: "Starting state unknown", evidence: { failureKind: "reset" } },
      "check-results.json": { schemaVersion: 1, entries: [
        { checkId: "ME", kind: "api", ran: false, classification: "unsupported", blockedReason: "No session cookie applies", assertion: "me", observation: "Not run.", evidenceRefs: [], session: "unavailable" },
      ] },
      "check-usage.json": { requests: 0 },
    });
    const summary: QaSummary = buildQaSummary(dir, context);
    expect(summary.verdict.kind).toBe("needs-review");
    const [search, flaky] = summary.findings.applicationCandidates;
    expect(search).toMatchObject({ id: "SEARCH", reproduced: true, severity: "medium (provisional)" });
    expect(search!.expectedVsObserved).toEqual(["Query parameter q: expected coffee; observed (absent)"]);
    expect(search!.reproductionSteps).toEqual([
      "Sign in with the dedicated test account",
      "Open /statements",
      'Type "coffee" into searchbox "Search statements"',
      'Press Enter in searchbox "Search statements"',
      "Compare the page with the declared expected result",
    ]);
    expect(flaky).toMatchObject({ id: "FLAKY", reproduced: false, severity: "low (provisional)" });
    expect(summary.findings.autoqaFailures.map((f) => f.id)).toEqual(["GONE"]);
    expect(summary.findings.unsupported).toEqual([{ source: "api-check", id: "ME", reason: "No session cookie applies" }]);
    expect(summary.apiAuthentication.state).toBe("unsupported");
    expect(summary.accounting).toEqual({ browserActions: 7, httpCheckRequests: 0, modelDecisions: 3, externalModelRequests: 0, provider: "mock" });
  });

  it("all executed checks passed but some were not executed: partial, not a full pass", () => {
    const dir = runDir({
      "run-summary.json": runSummary(),
      "authentication.json": { status: "success" },
      "workflow-manifest.json": { schemaVersion: 1, profileId: "demo", pages: ["/statements"], workflows: [workflow("OK"), workflow("LATER")] },
      "workflows/OK.json": { workflowId: "OK", status: "completed", reason: "passed", evidence: { failureKind: null } },
      "workflows/LATER.json": { workflowId: "LATER", status: "blocked", reason: "budget", evidence: { failureKind: "budget" } },
    });
    expect(buildQaSummary(dir, context).verdict).toMatchObject({ kind: "partial", executedChecks: 1, notExecuted: 1 });
  });
});

describe("qa-summary: end to end through RunManager", () => {
  const credentials = { username: "demo-a", password: "demo-a-synthetic-password" };
  let server: AuthFixtureServer | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it("writes qa-summary.json with the reproduced mismatch, the passing workflow and the application identity", async () => {
    server = await startAuthFixtureServer();
    const origin = server.origin;
    const root = mkdtempSync(join(tmpdir(), "autoqa-qa-e2e-"));
    const profiles = join(root, "profiles"); mkdirSync(profiles);
    writeFileSync(join(profiles, "auth.json"), JSON.stringify({
      schemaVersion: 1, id: "auth", name: "Synthetic auth", target: { url: `${origin}/home`, environmentKind: "owned-sandbox" },
      navigation: { allowedOrigins: [origin], allowedPathPrefixes: ["/"] }, resources: { allowedApiOrigins: [origin], allowedFormSubmitEndpoints: [] },
      workflows: { allowedWorkflowKinds: ["navigate"], executionMode: "declared" },
      auth: { mode: "form-login", checksVerified: true, loginUrl: `${origin}/login`, usernameField: { label: "Username" }, passwordField: { label: "Password" }, submitControl: { role: "button", name: "Sign in" }, successUrlPattern: `^${origin.replace(/[.]/g, "\\.")}/home(?:[?#].*)?$`, authenticatedSignal: { role: "heading", name: "Demo Home" }, allowedRequests: [{ origin, method: "POST", pathname: "/session" }] },
      provider: { explorer: { provider: "mock" }, critic: { enabled: true, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 30000 },
      limits: { maxActions: 25, maxModelCalls: 20, maxPages: 5, maxFindings: 5, maxDurationMs: 90000, maxCriticCalls: 5 },
    }));
    const open = (id: string, heading: string) => ({
      id, page: "/home", kind: "navigate", description: `Open Statements (${id})`, preconditions: "Signed in on /home", authorizedActions: "Click Statements only", expectedOutcome: `${heading} heading visible`,
      execution: { steps: [{ pathname: "/home", resultingPathname: "/statements", action: { type: "click", target: { role: "link", name: "Statements" } } }], completion: { urlPattern: "/statements$", visible: { role: "heading", name: heading } } },
    });
    writeFileSync(join(profiles, "auth.workflows.json"), JSON.stringify({ schemaVersion: 1, profileId: "auth", pages: ["/home"], workflows: [open("OPEN", "Statements"), open("STALE", "Statements (renamed)")] }));
    const runs = join(root, "runs");
    const manager = new RunManager(new ProfileStore(profiles), runs);
    const { runId } = await manager.startRun({ profileId: "auth", mode: "demo", credentials });
    const deadline = Date.now() + 90_000;
    while (manager.getActiveRun() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

    const text = readFileSync(join(runs, runId, "qa-summary.json"), "utf-8");
    const summary = JSON.parse(text) as QaSummary;
    expect(summary.application).toMatchObject({ profileId: "auth", origin, environmentKind: "owned-sandbox" });
    expect(summary.application.fingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(summary.authentication.state).toBe("verified");
    expect(summary.workflows).toMatchObject({ selected: 2, completed: 1, failed: 1 });
    expect(summary.verdict.kind).toBe("needs-review");
    expect(summary.findings.applicationCandidates).toEqual([expect.objectContaining({ id: "STALE", reproduced: true, severity: "medium (provisional)" })]);
    expect(summary.findings.applicationCandidates[0]!.expectedVsObserved.join(" ")).toContain("Statements (renamed)");
    expect(text).not.toContain(credentials.password);
  }, 120_000);
});
