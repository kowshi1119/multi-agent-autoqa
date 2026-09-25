import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../../src/server/app.js";
import { preparedTarget } from "../helpers/prepared-target.js";

/**
 * Server-side target binding: an operation must name the exact
 * configuration it was prepared against. Every rejection is proven by the
 * target's own request counter, not only by the response code.
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function countingTarget(): Promise<{ origin: string; hits: () => number; reset: () => void }> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits++;
    if (req.url?.startsWith("/login")) { res.setHeader("content-type", "text/html"); res.end('<h1>Sign in</h1><label for="u">Username</label><input id="u"><label for="p">Password</label><input id="p" type="password"><button>Sign in</button>'); return; }
    res.setHeader("content-type", "text/html");
    res.end("<h1>Home</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits, reset: () => { hits = 0; } };
}

function profile(id: string, origin: string, formLogin = false) {
  return {
    schemaVersion: 1, id, name: `Profile ${id}`, target: { url: `${origin}/home`, environmentKind: "owned-sandbox" },
    navigation: { allowedOrigins: [origin], allowedPathPrefixes: ["/"] }, resources: { allowedApiOrigins: [origin], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"] },
    auth: formLogin
      ? { mode: "form-login", checksVerified: true, loginUrl: `${origin}/login`, usernameField: { label: "Username" }, passwordField: { label: "Password" }, submitControl: { role: "button", name: "Sign in" }, successUrlPattern: "/home", authenticatedSignal: { role: "heading", name: "Home" } }
      : { mode: "none" },
    provider: { explorer: { provider: "mock" }, critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 1000 },
    limits: { maxActions: 3, maxModelCalls: 3, maxPages: 2, maxFindings: 2, maxDurationMs: 30000, maxCriticCalls: 1 },
  };
}

async function setup() {
  const [alpha, bravo] = [await countingTarget(), await countingTarget()];
  const root = mkdtempSync(join(tmpdir(), "autoqa-target-binding-"));
  const profiles = join(root, "profiles"); mkdirSync(profiles);
  writeFileSync(join(profiles, "alpha.json"), JSON.stringify(profile("alpha", alpha.origin)));
  writeFileSync(join(profiles, "bravo.json"), JSON.stringify(profile("bravo", bravo.origin, true)));
  const ui = await startServer({ port: 0, profilesDir: profiles, runsDir: join(root, "runs") });
  closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
  const base = `http://127.0.0.1:${ui.port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": ui.csrfToken }, body: JSON.stringify(body) });
  return { alpha, bravo, profiles, base, post };
}

describe("server-side target binding", () => {
  it("rejects a run whose prepared target belongs to a different application, sending nothing to either", async () => {
    const { alpha, bravo, base, post } = await setup();
    const alphaTarget = await preparedTarget(base, "alpha");
    alpha.reset(); bravo.reset();
    const response = await post("/api/runs", { profileId: "bravo", mode: "demo", credentials: { username: "u", password: "p" }, authenticationOnly: true, expected: alphaTarget });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("TARGET_CHANGED");
    expect(bravo.hits()).toBe(0);
    expect(alpha.hits()).toBe(0);
  });

  it("rejects a run with no prepared target at all (schema), sending nothing", async () => {
    const { bravo, post } = await setup();
    const response = await post("/api/runs", { profileId: "bravo", mode: "demo", authenticationOnly: true, credentials: { username: "u", password: "p" } });
    expect(response.status).toBe(400);
    expect(bravo.hits()).toBe(0);
  });

  it("rejects a run when the configuration changed between readiness and Start", async () => {
    const { alpha, profiles, base, post } = await setup();
    const prepared = await preparedTarget(base, "alpha");
    const path = join(profiles, "alpha.json");
    const edited = JSON.parse(readFileSync(path, "utf-8"));
    edited.name = "Profile alpha (edited)";
    writeFileSync(path, JSON.stringify(edited));
    alpha.reset();
    const response = await post("/api/runs", { profileId: "alpha", mode: "demo", expected: prepared });
    expect(response.status).toBe(409);
    expect(alpha.hits()).toBe(0);
  });

  it("rejects stale discovery and stale workflow saves before any browser launch or write", async () => {
    const { bravo, profiles, base, post } = await setup();
    const alphaTarget = await preparedTarget(base, "alpha");
    bravo.reset();
    for (const route of ["/api/profiles/bravo/auth-discovery", "/api/profiles/bravo/workflow-discovery"]) {
      const response = await post(route, { username: "u", password: "p", expected: alphaTarget });
      expect(response.status).toBe(409);
    }
    const save = await post("/api/profiles/bravo/workflows", { workflows: [{}], expected: alphaTarget });
    expect(save.status).toBe(409);
    expect(bravo.hits()).toBe(0);
    expect(() => readFileSync(join(profiles, "bravo.workflows.json"))).toThrow();
  });

  it("allows exactly one of two simultaneous starts with a valid prepared target", async () => {
    const { base, post } = await setup();
    const prepared = await preparedTarget(base, "alpha");
    const [first, second] = await Promise.all([
      post("/api/runs", { profileId: "alpha", mode: "demo", expected: prepared }),
      post("/api/runs", { profileId: "alpha", mode: "demo", expected: prepared }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const { runId } = (await (first.status === 200 ? first : second).json()) as { runId: string };
    await post(`/api/runs/${runId}/stop`, {});
    for (let i = 0; i < 200; i++) {
      const status = (await (await fetch(`${base}/api/runs/${runId}/status`)).json()) as { active: boolean };
      if (!status.active) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 30000);
});
