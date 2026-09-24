import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { runApiChecks } from "../../src/checks/run-api-checks.js";
import { loadCheckLedger } from "../../src/checks/evidence.js";
import { checkBudget, type RunSession } from "../../src/checks/request-scope.js";
import type { DeclaredApiCheck } from "../../src/checks/checks-manifest.js";
import { parseProfile, type ProjectProfile } from "../../src/profiles/schema.js";

/**
 * Run-scoped authenticated checks against a synthetic cookie-session target.
 * `cookieHeaderFor` stands in for the run's BrowserContext.cookies([url]):
 * it returns the session cookie only for the fixture's own origin, like
 * Playwright's domain matching. Every "denied" case asserts the target's
 * own hit counter, not just the ledger text.
 */
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });

async function fixture(options: Parameters<typeof startAuthFixtureServer>[0] = {}): Promise<AuthFixtureServer> {
  const server = await startAuthFixtureServer(options);
  servers.push(server);
  return server;
}

async function login(server: AuthFixtureServer, account: "demo-a" | "demo-b"): Promise<string> {
  const response = await fetch(`${server.origin}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: account, password: `${account}-synthetic-password` }) });
  const cookie = response.headers.getSetCookie()[0];
  if (!cookie) throw new Error("fixture login failed");
  return cookie.split(";")[0] as string;
}

function sessionFor(server: AuthFixtureServer, cookie: string | undefined): RunSession {
  return { authenticated: true, loginPathname: "/login", cookieHeaderFor: async (url) => (cookie && new URL(url).origin === server.origin ? cookie : undefined) };
}

function profileFor(origin: string, extra: Partial<ProjectProfile["apiChecks"]> = {}): ProjectProfile {
  return parseProfile({
    schemaVersion: 1, id: "session-checks", name: "Session checks",
    target: { url: `${origin}/home`, environmentKind: "owned-sandbox" },
    navigation: { allowedOrigins: [origin], allowedPathPrefixes: ["/"] },
    resources: { allowedApiOrigins: [origin], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"] },
    auth: { mode: "form-login", checksVerified: true, loginUrl: `${origin}/login`, usernameField: { label: "Username" }, passwordField: { label: "Password" }, submitControl: { role: "button", name: "Sign in" }, successUrlPattern: "/home", authenticatedSignal: { role: "heading", name: "Demo Home" }, allowedRequests: [{ origin, method: "POST", pathname: "/session" }] },
    provider: { explorer: { provider: "mock" }, critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 30000 },
    limits: { maxActions: 25, maxModelCalls: 20, maxPages: 5, maxFindings: 10, maxDurationMs: 60000, maxCriticCalls: 5, maxApiRequests: 10 },
    apiChecks: { enabled: true, allowedMutatingEndpoints: [], responseSizeCapBytes: 65536, useRunSession: true, ...extra },
  });
}

const check = (id: string, pathname: string, assertions: DeclaredApiCheck["assertions"] = { expectedStatus: 200, invariants: [] }, method: DeclaredApiCheck["method"] = "GET"): DeclaredApiCheck =>
  ({ id, method, pathname, description: `${method} ${pathname}`, assertions });

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? allFiles(p) : [p]; });
}

describe("run-scoped authenticated API checks", () => {
  it("reads an authenticated endpoint with the run's session and never writes the session value to evidence", async () => {
    const server = await fixture();
    const cookie = await login(server, "demo-a");
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-session-ok-"));
    const budget = checkBudget(profileFor(server.origin));
    await runApiChecks(profileFor(server.origin), [check("ME", "/api/me", { expectedStatus: 200, requiredFields: ["id", "email"], invariants: [] })], runDir, 1, server.origin, [], undefined, budget, sessionFor(server, cookie));

    const entry = loadCheckLedger(runDir).entries[0];
    expect(entry?.classification).toBe("passed");
    expect(entry?.session).toBe("run-session");
    expect(budget.used).toBe(1);
    const sid = cookie.split("=")[1] as string;
    for (const file of allFiles(runDir)) {
      const text = readFileSync(file, "utf-8");
      expect(text).not.toContain(sid);
      expect(() => JSON.parse(text)).not.toThrow();
    }
  });

  it("sends nothing when no session cookie applies to the URL (token/storage sessions are not transferable)", async () => {
    const server = await fixture();
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-session-none-"));
    const budget = checkBudget(profileFor(server.origin));
    await runApiChecks(profileFor(server.origin), [check("ME", "/api/me")], runDir, 1, server.origin, [], undefined, budget, sessionFor(server, undefined));
    expect(server.hits.get("GET /api/me") ?? 0).toBe(0);
    expect(budget.used).toBe(0);
    expect(loadCheckLedger(runDir).entries[0]?.blockedReason).toContain("no anonymous request was sent");
  });

  it("marks a rejected session as expired and stops sending further authenticated requests", async () => {
    const server = await fixture();
    const cookie = await login(server, "demo-a");
    server.expireAllSessions();
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-session-rejected-"));
    await runApiChecks(profileFor(server.origin), [check("ME", "/api/me"), check("STATEMENTS", "/api/statements")], runDir, 1, server.origin, [], undefined, undefined, sessionFor(server, cookie));
    const [first, second] = loadCheckLedger(runDir).entries;
    expect(first?.observation).toContain("rejected the authenticated session (HTTP 401");
    expect(first?.session).toBe("expired");
    expect(second?.blockedReason).toContain("expired earlier in this run");
    expect(server.hits.get("GET /api/statements") ?? 0).toBe(0);
  });

  it("treats a redirect to the login page as an expired session, without following it", async () => {
    const server = await fixture();
    const cookie = await login(server, "demo-a");
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-session-redirect-login-"));
    await runApiChecks(profileFor(server.origin), [check("REDIR", "/api/redirect-login")], runDir, 1, server.origin, [], undefined, undefined, sessionFor(server, cookie));
    expect(loadCheckLedger(runDir).entries[0]?.observation).toContain("redirect to login");
    expect(server.hits.get("GET /login") ?? 0).toBe(0);
  });

  it("records session expiry during the confirmation attempt instead of claiming a reproduced mismatch", async () => {
    const server = await fixture({ sessionMaxRequests: 1 });
    const cookie = await login(server, "demo-a");
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-session-midcheck-"));
    const budget = checkBudget(profileFor(server.origin));
    const { findings } = await runApiChecks(profileFor(server.origin), [check("ME", "/api/me", { requiredFields: ["missingField"], invariants: [] })], runDir, 1, server.origin, [], undefined, budget, sessionFor(server, cookie));
    const entry = loadCheckLedger(runDir).entries[0];
    expect(entry?.classification).toBe("needs_review");
    expect(entry?.observation).toContain("Confirmation not evaluated");
    expect(findings[0]?.reportDisposition).toBe("needs_human");
    expect(budget.used).toBe(2); // the first read AND the rejected confirmation were both really sent
  });

  it("does not follow an off-origin redirect, so the session never reaches the other origin", async () => {
    let offsiteHits = 0;
    const offsite: Server = createServer((_req, res) => { offsiteHits++; res.end("offsite"); });
    await new Promise<void>((resolve) => offsite.listen(0, "127.0.0.1", resolve));
    servers.push({ close: () => new Promise<void>((r) => { offsite.closeAllConnections(); offsite.close(() => r()); }) });
    const server = await fixture({ offsiteUrl: `http://127.0.0.1:${(offsite.address() as AddressInfo).port}/steal` });
    const cookie = await login(server, "demo-a");
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-session-offsite-"));
    await runApiChecks(profileFor(server.origin), [check("OFF", "/api/redirect-offsite")], runDir, 1, server.origin, [], undefined, undefined, sessionFor(server, cookie));
    expect(offsiteHits).toBe(0);
    expect(loadCheckLedger(runDir).entries[0]?.observation).toContain("status === 200 (got 302)");
  });

  it("denies an unauthorized mutation before any request reaches the target", async () => {
    const server = await fixture();
    const cookie = await login(server, "demo-a");
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-session-mutation-"));
    await runApiChecks(profileFor(server.origin), [check("TRANSFER", "/api/transfer", { expectedStatus: 200, invariants: [] }, "POST")], runDir, 1, server.origin, [], undefined, undefined, sessionFor(server, cookie));
    expect(server.hits.get("POST /api/transfer") ?? 0).toBe(0);
    expect(loadCheckLedger(runDir).entries[0]?.blockedReason).toContain("not present in apiChecks.allowedMutatingEndpoints");
  });

  it("stops reading an oversized authenticated response at the byte cap", async () => {
    const server = await fixture();
    const cookie = await login(server, "demo-a");
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-session-big-"));
    await runApiChecks(profileFor(server.origin), [check("BIG", "/api/big")], runDir, 1, server.origin, [], undefined, undefined, sessionFor(server, cookie));
    const entry = loadCheckLedger(runDir).entries[0];
    expect(entry?.ran).toBe(true);
    expect(entry?.observation).toContain("exceeded the byte limit");
  });

  it("aborts promptly when Stop arrives while the response body is still streaming", async () => {
    const server = await fixture({ slowBodyMs: 10_000 });
    const cookie = await login(server, "demo-a");
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-session-cancel-"));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    await runApiChecks(profileFor(server.origin), [check("SLOW", "/api/slow-body"), check("ME", "/api/me")], runDir, 1, server.origin, [], controller.signal, undefined, sessionFor(server, cookie));
    expect(Date.now() - started).toBeLessThan(3_000);
    const [slow, next] = loadCheckLedger(runDir).entries;
    expect(slow?.observation).toMatch(/cancelled|timed out/i);
    expect(next?.blockedReason).toContain("cancelled");
    expect(server.hits.get("GET /api/me") ?? 0).toBe(0);
  });

  it("keeps two runs' sessions independent -- each requester only ever sees its own account", async () => {
    const server = await fixture();
    const [cookieA, cookieB] = [await login(server, "demo-a"), await login(server, "demo-b")];
    const dirA = mkdtempSync(join(tmpdir(), "autoqa-session-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "autoqa-session-b-"));
    await runApiChecks(profileFor(server.origin), [check("ME", "/api/me")], dirA, 1, server.origin, [], undefined, undefined, sessionFor(server, cookieA));
    await runApiChecks(profileFor(server.origin), [check("ME", "/api/me")], dirB, 1, server.origin, [], undefined, undefined, sessionFor(server, cookieB));
    const idIn = (dir: string) => (JSON.parse(readFileSync(join(dir, "checks", "ME", "response.json"), "utf-8")) as { body: { id: string } }).body.id;
    expect(idIn(dirA)).toBe("demo-a");
    expect(idIn(dirB)).toBe("demo-b");
  });
});
