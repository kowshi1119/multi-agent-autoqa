import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { createLogger } from "../../src/logger.js";
import { completionPatternFor, relatesTo, runWorkflowDiscovery, validateDiscoveredWorkflow } from "../../src/pilot/workflow-discovery.js";
import { loadWorkflowManifest, saveWorkflowManifest, type DeclaredWorkflow } from "../../src/pilot/workflow-manifest.js";
import { parseProfile, type ProjectProfile } from "../../src/profiles/schema.js";
import { ProfileStore } from "../../src/profiles/store.js";
import { RunManager } from "../../src/run-manager.js";

const credentials = { username: "demo-a", password: "demo-a-synthetic-password" };
let server: AuthFixtureServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

function profileFor(origin: string, checksVerified = true): ProjectProfile {
  return parseProfile({
    schemaVersion: 1, id: "wf", name: "Workflow discovery", target: { url: `${origin}/home`, environmentKind: "owned-sandbox" },
    navigation: { allowedOrigins: [origin], allowedPathPrefixes: ["/"] }, resources: { allowedApiOrigins: [origin], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"], executionMode: "declared" },
    auth: { mode: "form-login", checksVerified, loginUrl: `${origin}/login`, usernameField: { label: "Username" }, passwordField: { label: "Password" }, submitControl: { role: "button", name: "Sign in" }, successUrlPattern: `^${origin.replace(/[.]/g, "\\.")}/home(?:[?#].*)?$`, authenticatedSignal: { role: "heading", name: "Demo Home" }, allowedRequests: [{ origin, method: "POST", pathname: "/session" }] },
    provider: { explorer: { provider: "mock" }, critic: { enabled: true, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 30000 },
    limits: { maxActions: 25, maxModelCalls: 20, maxPages: 6, maxFindings: 5, maxDurationMs: 90000, maxCriticCalls: 5 },
  });
}

describe("read-only workflow discovery", () => {
  it("proposes only read-only, in-scope links whose destination shows an observed heading", async () => {
    server = await startAuthFixtureServer();
    const logPath = join(mkdtempSync(join(tmpdir(), "autoqa-wf-log-")), "discovery.log");
    const result = await runWorkflowDiscovery(profileFor(server.origin), credentials, createLogger(logPath, [credentials.username, credentials.password]));
    expect(result.status).toBe("observed");
    if (result.status !== "observed") return;

    // Navigation drafts from the landing page; list-page drafts (search, detail, ...) are covered in stateful-workflows.test.ts.
    const fromHome = result.candidates.filter((w) => w.page === "/home");
    const byName = new Map(fromHome.map((w) => [w.execution!.steps[0]!.action.type === "click" ? (w.execution!.steps[0]!.action as { target: { name: string } }).target.name : "", w]));
    expect([...byName.keys()].sort()).toEqual(["Help", "Profile", "Statements"]);
    expect(byName.get("Statements")?.execution?.completion).toEqual({ urlPattern: completionPatternFor(server.origin, "/statements"), visible: { role: "heading", name: "Statements" } });

    const skippedReason = (name: string) => result.skipped.find((s) => s.name === name)?.reason ?? "";
    expect(skippedReason("Delete account")).toContain("state-changing");
    expect(skippedReason("Send money")).toContain("state-changing");
    expect(skippedReason("Log out")).toContain("state-changing");
    expect(skippedReason("Partner offers")).toContain("Outside the approved");
    expect(skippedReason("Activity")).toContain("No unique visible heading");
    // The destructive destinations were never visited, only read as link names.
    expect(server.hits.get("GET /settings/delete-account") ?? 0).toBe(0);
    expect(server.hits.get("GET /transfers/new") ?? 0).toBe(0);
    expect(server.hits.get("GET /logout") ?? 0).toBe(0);

    for (const workflow of result.candidates) expect(validateDiscoveredWorkflow(profileFor(server.origin), workflow).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(logPath, "utf-8")).not.toContain(credentials.password);
  }, 60_000);

  it("pins links whose text appears more than once (as on the Ajeer sandbox) to their destination, and runs them", async () => {
    server = await startAuthFixtureServer({ duplicateLinks: true });
    const result = await runWorkflowDiscovery(profileFor(server.origin), credentials, createLogger());
    expect(result.status).toBe("observed");
    if (result.status !== "observed") return;
    const statements = result.candidates.find((w) => w.id === "NAV-STATEMENTS")!;
    expect(statements.execution!.steps[0]!.action).toEqual({ type: "click", target: { role: "link", name: "Statements", pathname: "/statements" } });
    expect(statements.authorizedActions).toContain("pinned to this destination");
    // "Help" also appears as a shortcut to a different page: the draft is pinned to the page it was observed on.
    const help = result.candidates.find((w) => w.id === "NAV-HELP")!;
    expect(help.execution!.steps[0]!.action).toEqual({ type: "click", target: { role: "link", name: "Help", pathname: "/help" } });
    // An anchor exposed as a menu item (role query finds nothing) is identified by text + destination.
    const profilePage = result.candidates.find((w) => w.id === "NAV-PROFILE")!;
    expect(profilePage.execution!.steps[0]!.action).toEqual({ type: "click", target: { role: "link", name: "Profile", pathname: "/profile" } });
    expect(validateDiscoveredWorkflow(profileFor(server.origin), statements).ok).toBe(true);
    const tampered = structuredClone(statements);
    (tampered.execution!.steps[0]!.action as { target: { pathname: string } }).target.pathname = "/profile";
    expect(validateDiscoveredWorkflow(profileFor(server.origin), tampered).ok).toBe(false);

    const root = mkdtempSync(join(tmpdir(), "autoqa-wf-dup-"));
    const profiles = join(root, "profiles"); mkdirSync(profiles);
    writeFileSync(join(profiles, "wf.json"), JSON.stringify(profileFor(server.origin)));
    saveWorkflowManifest(profiles, "wf", [statements, profilePage, help]);
    const manager = new RunManager(new ProfileStore(profiles), join(root, "runs"));
    const { runId } = await manager.startRun({ profileId: "wf", mode: "demo", credentials });
    const deadline = Date.now() + 90_000;
    while (manager.getActiveRun() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    for (const id of ["NAV-STATEMENTS", "NAV-PROFILE", "NAV-HELP"]) {
      const outcome = JSON.parse(readFileSync(join(root, "runs", runId, "workflows", `${id}.json`), "utf-8")) as { status: string };
      expect(outcome.status).toBe("completed");
    }
  }, 150_000);

  it("waits for a client-rendered menu after returning to the start page (found on the Ajeer sandbox)", async () => {
    server = await startAuthFixtureServer({ lateRender: true });
    const result = await runWorkflowDiscovery(profileFor(server.origin), credentials, createLogger());
    expect(result.status).toBe("observed");
    if (result.status !== "observed") return;
    // Every in-scope read-only link is still found after each return to /home, not just the first one.
    expect(result.candidates.filter((w) => w.page === "/home").map((w) => w.id).sort()).toEqual(["NAV-HELP", "NAV-PROFILE", "NAV-STATEMENTS"]);
    expect(result.skipped.filter((s) => /ambiguous/.test(s.reason))).toEqual([]);
  }, 120_000);

  it("a background request the policy blocks sets aside only that page's probes and is reported (found on the Ajeer sandbox)", async () => {
    server = await startAuthFixtureServer({ backgroundPost: true });
    const profile = parseProfile({ ...profileFor(server.origin), workflows: { allowedWorkflowKinds: ["navigate", "search", "filter", "paginate"], executionMode: "declared" }, resources: { allowedApiOrigins: [server.origin], allowedFormSubmitEndpoints: [{ method: "get", pathname: "/statements" }] }, limits: { ...profileFor(server.origin).limits, maxActions: 60 } });
    const result = await runWorkflowDiscovery(profile, credentials, createLogger());
    expect(result.status).toBe("observed");
    if (result.status !== "observed") return;
    // Navigation drafts survive; the statements page's own probes are set aside, not the whole discovery.
    expect(result.candidates.filter((w) => w.page === "/home").map((w) => w.id).sort()).toEqual(["NAV-HELP", "NAV-PROFILE", "NAV-STATEMENTS"]);
    expect(result.candidates.find((w) => w.id === "NAV-STATEMENTS")?.limitations).toContain("POST /api/track");
    expect(result.candidates.some((w) => w.page === "/statements")).toBe(false);
    expect(result.skipped.find((s) => s.name === "/statements")?.reason).toContain("POST /api/track");
    expect(result.blockedRequests).toContainEqual(expect.objectContaining({ method: "POST", pathname: "/api/track" }));
    // Blocked means never sent.
    expect(server.hits.get("POST /api/track") ?? 0).toBe(0);
  }, 150_000);

  it("uses a heading related to the link, never an unrelated one such as the member's name (found on the Ajeer sandbox)", async () => {
    server = await startAuthFixtureServer({ personalHeading: true });
    const result = await runWorkflowDiscovery(profileFor(server.origin), credentials, createLogger());
    expect(result.status).toBe("observed");
    if (result.status !== "observed") return;
    expect(result.candidates.find((w) => w.id === "NAV-PROFILE")?.execution?.completion.visible).toEqual({ role: "heading", name: "Profile details" });
    expect(result.candidates.find((w) => w.id === "NAV-HELP")).toBeUndefined();
    expect(result.skipped.find((s) => s.name === "Help")?.reason).toContain("relates to the link text");
    expect(JSON.stringify(result)).not.toContain("Demo A Person");
    expect(relatesTo("Transaction History", "Transactions")).toBe(true);
    expect(relatesTo("Kowshi Mathi", "My Account")).toBe(false);
  }, 120_000);

  it("refuses to run before the login conditions are verified, and fails cleanly on rejected credentials", async () => {
    server = await startAuthFixtureServer();
    const unverified = await runWorkflowDiscovery(profileFor(server.origin, false), credentials, createLogger());
    expect(unverified).toEqual({ status: "failed", reason: expect.stringContaining("Verify the login conditions first") });
    expect(server.hits.size).toBe(0);

    const wrong = await runWorkflowDiscovery(profileFor(server.origin), { username: "demo-a", password: "not-the-password" }, createLogger());
    expect(wrong.status).toBe("failed");
    if (wrong.status === "failed") {
      expect(wrong.reason).toContain("stayed-on-login");
      expect(wrong.reason).toContain("did not retry");
    }
    // A rejected password is submitted exactly once (no retry that could lock a real account).
    expect(server.hits.get("POST /session")).toBe(1);
  }, 60_000);

  it("rejects tampered drafts on save: other actions, out-of-scope paths, edited patterns, state-changing controls", () => {
    const origin = "http://localhost:4999";
    const profile = profileFor(origin);
    const good: DeclaredWorkflow = {
      id: "NAV-STATEMENTS", page: "/home", kind: "navigate", description: "d", preconditions: "p", authorizedActions: "a", expectedOutcome: "e",
      execution: { steps: [{ pathname: "/home", resultingPathname: "/statements", action: { type: "click", target: { role: "link", name: "Statements" } } }], completion: { urlPattern: completionPatternFor(origin, "/statements"), visible: { role: "heading", name: "Statements" } } },
    };
    expect(validateDiscoveredWorkflow(profile, good).ok).toBe(true);
    const tamper = (change: (w: DeclaredWorkflow) => void) => { const copy = structuredClone(good); change(copy); return validateDiscoveredWorkflow(profile, copy); };
    expect(tamper((w) => { w.execution!.steps[0]!.action = { type: "fill", target: { label: "Amount" }, value: "100" }; }).ok).toBe(false);
    expect(tamper((w) => { w.execution!.steps[0]!.action = { type: "click", target: { role: "button", name: "Statements" } }; }).ok).toBe(false);
    expect(tamper((w) => { w.execution!.completion.urlPattern = ".*"; }).ok).toBe(false);
    expect(tamper((w) => { w.execution!.steps[0]!.action = { type: "click", target: { role: "link", name: "Send money" } }; }).ok).toBe(false);
    expect(tamper((w) => { w.execution!.steps[0]!.resultingPathname = "/settings/delete-account"; w.execution!.completion.urlPattern = completionPatternFor(origin, "/settings/delete-account"); }).ok).toBe(false);
    expect(tamper((w) => { w.execution!.steps.push({ pathname: "/statements", action: { type: "click", target: { role: "link", name: "Back to home" } } }); }).ok).toBe(false);
    expect(tamper((w) => { w.execution!.completion.visible = { role: "link", name: "Statements" }; }).ok).toBe(false);
  });

  it("saved workflows execute to 'completed' with evidence, and a stale heading yields 'failed', never 'completed'", async () => {
    server = await startAuthFixtureServer();
    const discovered = await runWorkflowDiscovery(profileFor(server.origin), credentials, createLogger());
    if (discovered.status !== "observed") throw new Error("discovery failed");
    const statements = discovered.candidates.find((w) => w.id === "NAV-STATEMENTS")!;
    // Negative control: the declared heading no longer matches the page.
    const stale: DeclaredWorkflow = { ...structuredClone(discovered.candidates.find((w) => w.id === "NAV-HELP")!), id: "NAV-HELP-STALE" };
    stale.execution!.completion.visible = { role: "heading", name: "Help centre (renamed)" };

    const root = mkdtempSync(join(tmpdir(), "autoqa-wf-run-"));
    const profiles = join(root, "profiles"); mkdirSync(profiles);
    writeFileSync(join(profiles, "wf.json"), JSON.stringify(profileFor(server.origin)));
    const profilePage = discovered.candidates.find((w) => w.id === "NAV-PROFILE")!;
    saveWorkflowManifest(profiles, "wf", [statements, profilePage, stale]);
    expect(loadWorkflowManifest(profiles, "wf")?.workflows.map((w) => w.id)).toEqual(["NAV-STATEMENTS", "NAV-PROFILE", "NAV-HELP-STALE"]);

    const manager = new RunManager(new ProfileStore(profiles), join(root, "runs"));
    const { runId } = await manager.startRun({ profileId: "wf", mode: "demo", credentials });
    const deadline = Date.now() + 90_000;
    while (manager.getActiveRun() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const status = (id: string) => JSON.parse(readFileSync(join(root, "runs", runId, "workflows", `${id}.json`), "utf-8")) as { status: string; evidence: { assertion?: { passed: boolean } } };
    expect(status("NAV-STATEMENTS").status).toBe("completed");
    expect(status("NAV-STATEMENTS").evidence.assertion?.passed).toBe(true);
    // Each later workflow starts on /home again although the previous one ended elsewhere.
    expect(status("NAV-PROFILE").status).toBe("completed");
    expect(status("NAV-HELP-STALE").status).toBe("failed");
    expect(status("NAV-HELP-STALE").evidence.assertion?.passed).toBe(false);
  }, 150_000);
});
