import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { ProfileStore } from "../../src/profiles/store.js";
import { RunManager } from "../../src/run-manager.js";
import type { RunProgressEvent } from "../../src/progress.js";

/**
 * End to end through RunManager with real Chromium: the run logs in, runs a
 * declared read-only workflow, then runs declared API checks with ITS OWN
 * session while the browser context is still open. Synthetic accounts only.
 */
const credentials = { username: "demo-a", password: "demo-a-synthetic-password" };
let server: AuthFixtureServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

function setup(origin: string, options: { useRunSession?: boolean; checks?: unknown[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "autoqa-auth-checks-"));
  const profiles = join(root, "profiles"); mkdirSync(profiles);
  writeFileSync(join(profiles, "auth.json"), JSON.stringify({
    schemaVersion: 1, id: "auth", name: "Synthetic auth", target: { url: `${origin}/home`, environmentKind: "owned-sandbox" },
    navigation: { allowedOrigins: [origin], allowedPathPrefixes: ["/"] }, resources: { allowedApiOrigins: [origin], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"], executionMode: "declared" },
    auth: { mode: "form-login", checksVerified: true, loginUrl: `${origin}/login`, usernameField: { label: "Username" }, passwordField: { label: "Password" }, submitControl: { role: "button", name: "Sign in" }, successUrlPattern: `^${origin.replace(/[.]/g, "\\.")}/home(?:[?#].*)?$`, authenticatedSignal: { role: "heading", name: "Demo Home" }, allowedRequests: [{ origin, method: "POST", pathname: "/session" }] },
    provider: { explorer: { provider: "mock" }, critic: { enabled: true, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 30000 },
    limits: { maxActions: 25, maxModelCalls: 20, maxPages: 5, maxFindings: 5, maxDurationMs: 90000, maxCriticCalls: 5, maxApiRequests: 6 },
    apiChecks: { enabled: true, allowedMutatingEndpoints: [], responseSizeCapBytes: 65536, useRunSession: options.useRunSession ?? true },
  }));
  writeFileSync(join(profiles, "auth.workflows.json"), JSON.stringify({ schemaVersion: 1, profileId: "auth", pages: ["/home"], workflows: [{
    id: "OPEN-STATEMENTS", page: "/home", kind: "navigate", description: "Open Statements", preconditions: "Signed in on /home", authorizedActions: "Click the Statements link only", expectedOutcome: "Statements heading visible on /statements",
    execution: { steps: [{ pathname: "/home", resultingPathname: "/statements", action: { type: "click", target: { role: "link", name: "Statements" } } }], completion: { urlPattern: `/statements$`, visible: { role: "heading", name: "Statements" } } },
  }] }));
  writeFileSync(join(profiles, "auth.checks.json"), JSON.stringify({ schemaVersion: 1, profileId: "auth", securityChecks: [], apiChecks: options.checks ?? [
    { id: "ME", method: "GET", pathname: "/api/me", description: "Signed-in member can read their own profile", assertions: { expectedStatus: 200, requiredFields: ["id", "email"] } },
    { id: "TRANSFER", method: "POST", pathname: "/api/transfer", description: "Must never be sent", assertions: { expectedStatus: 200 } },
  ] }));
  const runs = join(root, "runs");
  return { manager: new RunManager(new ProfileStore(profiles), runs), runs };
}

async function runToEnd(manager: RunManager, input: Parameters<RunManager["startRun"]>[0], onEvent?: (event: RunProgressEvent, runId: string) => void) {
  const { runId } = await manager.startRun(input);
  const events: RunProgressEvent[] = [];
  manager.subscribe(runId, (event) => { events.push(event); onEvent?.(event, runId); });
  const deadline = Date.now() + 90_000;
  while (manager.getActiveRun() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return { runId, events };
}

function allText(dir: string): string {
  return readdirSync(dir).map((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? allText(p) : readFileSync(p, "utf-8"); }).join("\n");
}

describe("RunManager: run-scoped authenticated checks", () => {
  it("logs in, completes a declared workflow, then checks /api/me with the run's own session; the mutation is never sent", async () => {
    server = await startAuthFixtureServer();
    const { manager, runs } = setup(server.origin);
    const { runId, events } = await runToEnd(manager, { profileId: "auth", mode: "demo", credentials });
    const dir = join(runs, runId);

    expect(JSON.parse(readFileSync(join(dir, "authentication.json"), "utf-8")).status).toBe("success");
    expect(JSON.parse(readFileSync(join(dir, "workflows", "OPEN-STATEMENTS.json"), "utf-8")).status).toBe("completed");
    const ledger = JSON.parse(readFileSync(join(dir, "check-results.json"), "utf-8")) as { entries: Array<{ checkId: string; classification: string; session: string }> };
    expect(ledger.entries.find((e) => e.checkId === "ME")).toMatchObject({ classification: "passed", session: "run-session" });
    expect(ledger.entries.find((e) => e.checkId === "TRANSFER")?.classification).toBe("unsupported");
    expect(server.hits.get("POST /api/transfer") ?? 0).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "check-usage.json"), "utf-8"))).toMatchObject({ requests: 1, sessionMode: "run-session" });
    expect(JSON.parse(readFileSync(join(dir, "run-summary.json"), "utf-8")).status).toBe("completed");
    expect(allText(dir)).not.toContain(credentials.password);
    expect(events.filter((e) => ["completed", "stopped", "failed"].includes(e.phase))).toHaveLength(1);
  }, 120_000);

  it("keeps an authentication-only run authentication-only: no checks, no check ledger", async () => {
    server = await startAuthFixtureServer();
    const { manager, runs } = setup(server.origin);
    const { runId } = await runToEnd(manager, { profileId: "auth", mode: "demo", credentials, authenticationOnly: true });
    expect(existsSync(join(runs, runId, "check-results.json"))).toBe(false);
    expect(server.hits.get("GET /api/me") ?? 0).toBe(0);
  }, 120_000);

  it("without the useRunSession opt-in, records the check as unsupported and sends nothing", async () => {
    server = await startAuthFixtureServer();
    const { manager, runs } = setup(server.origin, { useRunSession: false });
    const { runId } = await runToEnd(manager, { profileId: "auth", mode: "demo", credentials });
    const ledger = JSON.parse(readFileSync(join(runs, runId, "check-results.json"), "utf-8")) as { entries: Array<{ checkId: string; session: string; blockedReason?: string }> };
    expect(ledger.entries.find((e) => e.checkId === "ME")).toMatchObject({ session: "unavailable" });
    expect(server.hits.get("GET /api/me") ?? 0).toBe(0);
  }, 120_000);

  it("Stop during a streaming check body ends the run as cancelled, with usage and report saved and one terminal event", async () => {
    server = await startAuthFixtureServer({ slowBodyMs: 30_000 });
    const { manager, runs } = setup(server.origin, { checks: [
      { id: "SLOW", method: "GET", pathname: "/api/slow-body", description: "Slow body", assertions: { expectedStatus: 200 } },
      { id: "ME", method: "GET", pathname: "/api/me", description: "After stop", assertions: { expectedStatus: 200 } },
    ] });
    let stopped = false;
    const { runId, events } = await runToEnd(manager, { profileId: "auth", mode: "demo", credentials }, (event, id) => {
      if (!stopped && event.detail.includes("Running declared API and security checks")) {
        stopped = true;
        setTimeout(() => manager.stopRun(id), 500);
      }
    });
    const dir = join(runs, runId);
    expect(stopped).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "run-summary.json"), "utf-8")).status).toBe("cancelled");
    expect(existsSync(join(dir, "check-usage.json"))).toBe(true);
    expect(existsSync(join(dir, "report.json"))).toBe(true);
    expect(server.hits.get("GET /api/me") ?? 0).toBe(0);
    const terminal = events.filter((e) => ["completed", "stopped", "failed"].includes(e.phase));
    expect(terminal.map((e) => e.phase)).toEqual(["stopped"]);
  }, 120_000);
});
