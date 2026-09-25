import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { createLogger } from "../../src/logger.js";
import { completionPatternFor, runWorkflowDiscovery, validateDiscoveredWorkflow } from "../../src/pilot/workflow-discovery.js";
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

  it("refuses to run before the login conditions are verified, and fails cleanly on rejected credentials", async () => {
    server = await startAuthFixtureServer();
    const unverified = await runWorkflowDiscovery(profileFor(server.origin, false), credentials, createLogger());
    expect(unverified).toEqual({ status: "failed", reason: expect.stringContaining("Verify the login conditions first") });
    expect(server.hits.size).toBe(0);

    const wrong = await runWorkflowDiscovery(profileFor(server.origin), { username: "demo-a", password: "not-the-password" }, createLogger());
    expect(wrong.status).toBe("failed");
    if (wrong.status === "failed") expect(wrong.reason).toContain("did not satisfy the profile's verified conditions");
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
