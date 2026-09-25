import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { AuthMechanismObserver } from "../../src/auth/mechanism-observer.js";
import { ProfileStore } from "../../src/profiles/store.js";
import { RunManager } from "../../src/run-manager.js";

/**
 * How the application authenticates its own API calls is observed, not
 * assumed. The synthetic fixture's "bearer" mode issues a token that the app's
 * page script keeps in sessionStorage and sends as `Authorization: Bearer`;
 * its API rejects the cookie. Synthetic accounts only.
 */
const credentials = { username: "demo-a", password: "demo-a-synthetic-password" };
let server: AuthFixtureServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

function setup(origin: string, runSessionAuth: "cookie" | "observed-authorization") {
  const root = mkdtempSync(join(tmpdir(), "autoqa-auth-mech-"));
  const profiles = join(root, "profiles"); mkdirSync(profiles);
  writeFileSync(join(profiles, "auth.json"), JSON.stringify({
    schemaVersion: 1, id: "auth", name: "Synthetic auth", target: { url: `${origin}/home`, environmentKind: "owned-sandbox" },
    navigation: { allowedOrigins: [origin], allowedPathPrefixes: ["/"] }, resources: { allowedApiOrigins: [origin], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"], executionMode: "declared" },
    auth: { mode: "form-login", checksVerified: true, loginUrl: `${origin}/login`, usernameField: { label: "Username" }, passwordField: { label: "Password" }, submitControl: { role: "button", name: "Sign in" }, successUrlPattern: `^${origin.replace(/[.]/g, "\\.")}/home(?:[?#].*)?$`, authenticatedSignal: { role: "heading", name: "Demo Home" }, allowedRequests: [{ origin, method: "POST", pathname: "/session" }] },
    provider: { explorer: { provider: "mock" }, critic: { enabled: true, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 30000 },
    limits: { maxActions: 25, maxModelCalls: 20, maxPages: 5, maxFindings: 5, maxDurationMs: 90000, maxCriticCalls: 5, maxApiRequests: 6 },
    apiChecks: { enabled: true, allowedMutatingEndpoints: [], responseSizeCapBytes: 65536, useRunSession: true, runSessionAuth },
  }));
  writeFileSync(join(profiles, "auth.workflows.json"), JSON.stringify({ schemaVersion: 1, profileId: "auth", pages: ["/home"], workflows: [{
    id: "OPEN-STATEMENTS", page: "/home", kind: "navigate", description: "Open Statements", preconditions: "Signed in on /home", authorizedActions: "Click the Statements link only", expectedOutcome: "Statements heading visible on /statements",
    execution: { steps: [{ pathname: "/home", resultingPathname: "/statements", action: { type: "click", target: { role: "link", name: "Statements" } } }], completion: { urlPattern: `/statements$`, visible: { role: "heading", name: "Statements" } } },
  }] }));
  writeFileSync(join(profiles, "auth.checks.json"), JSON.stringify({ schemaVersion: 1, profileId: "auth", securityChecks: [], apiChecks: [
    { id: "ME", method: "GET", pathname: "/api/me", description: "Signed-in member can read their own profile", assertions: { expectedStatus: 200, requiredFields: ["id", "email"] } },
  ] }));
  const runs = join(root, "runs");
  return { manager: new RunManager(new ProfileStore(profiles), runs), runs };
}

async function runToEnd(manager: RunManager): Promise<string> {
  const { runId } = await manager.startRun({ profileId: "auth", mode: "demo", credentials });
  const deadline = Date.now() + 90_000;
  while (manager.getActiveRun() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return runId;
}

function allText(dir: string): string {
  return readdirSync(dir).map((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? allText(p) : readFileSync(p, "utf-8"); }).join("\n");
}

type Ledger = { entries: Array<{ checkId: string; classification: string; session?: string; sessionAuth?: string; blockedReason?: string; ran: boolean }> };

describe("authentication mechanism diagnosis", () => {
  it("on a bearer-token application, cookie mode reports a mechanism mismatch (not 'session expired') after one rejected request", async () => {
    server = await startAuthFixtureServer({ apiAuth: "bearer" });
    const { manager, runs } = setup(server.origin, "cookie");
    const dir = join(runs, await runToEnd(manager));

    const mechanism = JSON.parse(readFileSync(join(dir, "auth-mechanism.json"), "utf-8")) as { origins: Array<{ origin: string; apiRequestsObserved: number; withAuthorization: Record<string, number> }> };
    const observed = mechanism.origins.find((o) => o.origin === server!.origin)!;
    expect(observed.apiRequestsObserved).toBeGreaterThan(0);
    expect(observed.withAuthorization.Bearer).toBeGreaterThan(0);

    const me = (JSON.parse(readFileSync(join(dir, "check-results.json"), "utf-8")) as Ledger).entries.find((e) => e.checkId === "ME")!;
    expect(me).toMatchObject({ classification: "unsupported", ran: true, session: "unavailable" });
    expect(me.blockedReason).toContain("Authorization header (Bearer)");
    expect(me.blockedReason).toContain("cookie-based checks are unsupported");
    expect(me.blockedReason).not.toContain("expired");
    expect(JSON.parse(readFileSync(join(dir, "check-usage.json"), "utf-8")).requests).toBe(1);
    // Never persisted: the token, the session cookie, the password.
    const text = allText(dir);
    for (const token of server.issuedTokens) expect(text).not.toContain(token);
    expect(text).not.toContain(credentials.password);
  }, 120_000);

  it("observed-authorization mode reuses the app's own Bearer header for the same origin and the check passes; the value is never written", async () => {
    server = await startAuthFixtureServer({ apiAuth: "bearer" });
    const { manager, runs } = setup(server.origin, "observed-authorization");
    const dir = join(runs, await runToEnd(manager));

    const me = (JSON.parse(readFileSync(join(dir, "check-results.json"), "utf-8")) as Ledger).entries.find((e) => e.checkId === "ME")!;
    expect(me).toMatchObject({ classification: "passed", session: "run-session", sessionAuth: "observed-authorization" });
    expect(JSON.parse(readFileSync(join(dir, "check-usage.json"), "utf-8")).requests).toBe(1);
    const text = allText(dir);
    expect(server.issuedTokens.length).toBeGreaterThan(0);
    for (const token of server.issuedTokens) expect(text).not.toContain(token);
  }, 120_000);

  it("observed-authorization mode on a cookie application finds no Bearer header and sends nothing (no fallback to anonymous or cookie)", async () => {
    server = await startAuthFixtureServer({ apiAuth: "cookie" });
    const { manager, runs } = setup(server.origin, "observed-authorization");
    const dir = join(runs, await runToEnd(manager));
    const me = (JSON.parse(readFileSync(join(dir, "check-results.json"), "utf-8")) as Ledger).entries.find((e) => e.checkId === "ME")!;
    expect(me.classification).toBe("unsupported");
    expect(me.blockedReason).toContain("No Bearer Authorization header");
    expect(me.blockedReason).toContain("cookies only");
    expect(JSON.parse(readFileSync(join(dir, "check-usage.json"), "utf-8")).requests).toBe(0);
  }, 120_000);
});

describe("AuthMechanismObserver", () => {
  const fakeRequest = (url: string, headers: Record<string, string>, resourceType = "fetch") =>
    ({ url: () => url, resourceType: () => resourceType, allHeaders: async () => headers }) as unknown as Request;

  it("retains only Bearer values, only for approved origins, only when opted in; summaries never contain values", async () => {
    const observer = new AuthMechanismObserver(["https://api.example.test"], true);
    await observer.observe(fakeRequest("https://api.example.test/me", { authorization: "Bearer secret-token-1", cookie: "sid=abc" }));
    await observer.observe(fakeRequest("https://other.example.test/me", { authorization: "Bearer secret-token-2" }));
    await observer.observe(fakeRequest("https://api.example.test/page", { authorization: "Bearer secret-token-3" }, "document"));
    expect(observer.authorizationFor("https://api.example.test/accounts")).toBe("Bearer secret-token-1");
    expect(observer.authorizationFor("https://other.example.test/me")).toBeUndefined();
    expect(observer.authorizationFor("http://api.example.test/me")).toBeUndefined();

    const basic = new AuthMechanismObserver(["https://api.example.test"], true);
    await basic.observe(fakeRequest("https://api.example.test/me", { authorization: "Basic dXNlcjpwYXNz" }));
    expect(basic.authorizationFor("https://api.example.test/me")).toBeUndefined();
    expect(basic.describe("https://api.example.test/me")).toContain("(Basic)");

    const notOptedIn = new AuthMechanismObserver(["https://api.example.test"], false);
    await notOptedIn.observe(fakeRequest("https://api.example.test/me", { authorization: "Bearer secret-token-4" }));
    expect(notOptedIn.authorizationFor("https://api.example.test/me")).toBeUndefined();

    const summary = JSON.stringify([observer.summary(), basic.summary(), notOptedIn.summary()]);
    expect(summary).not.toMatch(/secret-token|dXNlcjpwYXNz|sid=abc/);
    expect(observer.summary().origins).toEqual([{ origin: "https://api.example.test", apiRequestsObserved: 1, withCookie: 1, withAuthorization: { Bearer: 1 } }]);
    expect(observer.describe("https://unseen.example.test/x")).toContain("unknown");
  });
});
