import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { runAuthDiscovery, discoverSignals } from "../../src/auth/discovery.js";
import { createLogger } from "../../src/logger.js";
import { parseProfile } from "../../src/profiles/schema.js";

/**
 * §Auth-discovery feature (2026-09-22): resolves the deadlock documented
 * in PHASE6_ACCEPTANCE.md -- a real AutoQA login refuses to run while
 * auth.checksVerified is false, but there's no way to know the real
 * post-login URL/signal without a real login. These tests prove
 * runAuthDiscovery() genuinely observes a real login's result (not a
 * placeholder-derived guess) and never persists the submitted credential
 * anywhere on disk -- the entire reason this path exists separately from
 * FormLoginBootstrap.
 */

let server: Server;
let ORIGIN: string;
const VALID_USERNAME = "discovery-test-user";
const VALID_PASSWORD = "discovery-test-password-DO-NOT-USE-99221";

const LOGIN_PAGE_HTML = `<!doctype html><html><body>
  <form id="login-form">
    <label for="u">Username</label>
    <input id="u" name="username" aria-label="Username" />
    <label for="p">Password</label>
    <input id="p" name="password" type="password" aria-label="Password" />
    <button type="submit" id="submit">Login</button>
  </form>
  <script>
    document.getElementById("login-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var u = document.getElementById("u").value;
      var p = document.getElementById("p").value;
      fetch("/api/login", { method: "POST", body: JSON.stringify({ u: u, p: p }) }).then(function () {
        window.location.href = "/dashboard-real?session=1";
      });
    });
  </script>
</body></html>`;

const DASHBOARD_HTML = `<!doctype html><html><body><h1>Real Dashboard</h1><nav aria-label="Main"><a href="/a">A</a></nav></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/api/login" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end("{}");
    }
    if (req.url?.startsWith("/dashboard-real")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(DASHBOARD_HTML);
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(LOGIN_PAGE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  ORIGIN = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function discoveryProfile() {
  return parseProfile({
    schemaVersion: 1,
    id: "discovery-test",
    name: "Test",
    target: { url: `${ORIGIN}/dashboard-real`, environmentKind: "owned-sandbox" },
    navigation: { allowedOrigins: [ORIGIN], allowedPathPrefixes: ["/"] },
    resources: { allowedApiOrigins: [ORIGIN], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"] },
    auth: {
      mode: "form-login",
      // Deliberately absent/false + wrong placeholders -- discovery must
      // not depend on these being correct, since establishing them is the
      // whole point.
      checksVerified: false,
      allowedRequests: [{ origin: ORIGIN, method: "POST", pathname: "/api/login" }],
      loginUrl: `${ORIGIN}/login`,
      usernameField: { role: "textbox", name: "Username" },
      passwordField: { label: "Password" },
      submitControl: { role: "button", name: "Login" },
      successUrlPattern: ".*this-will-never-match.*",
      authenticatedSignal: { role: "heading", name: "This Will Never Appear" },
    },
    provider: {
      explorer: { provider: "mock" },
      critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
      providerTimeoutMs: 30000,
    },
    limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
  });
}

describe("runAuthDiscovery (2026-09-22 fix: resolves the checksVerified deadlock)", () => {
  it("offers only unique usable named signals, never unnamed banner text, duplicates, hidden or credential-bearing headings", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<header>Demo Person Personal</header><main>Not a landmark name</main><h1>Overview</h1><h2>Repeated</h2><h2>Repeated</h2><h2 hidden>Hidden</h2><nav aria-labelledby="nav-name"><span id="nav-name">Workspace</span></nav><h2>' + VALID_PASSWORD + '</h2>');
      expect(await discoverSignals(page, [VALID_PASSWORD])).toEqual([
        { role: "heading", name: "Overview" }, { role: "navigation", name: "Workspace" }
      ]);
    } finally { await browser.close(); }
  });

  it("does not start a browser/login after cancellation or exceed the configured action budget", async () => {
    const controller = new AbortController(); controller.abort();
    expect(await runAuthDiscovery(discoveryProfile(), { username: "fake", password: "fake" }, createLogger(), controller.signal)).toEqual({ status: "failed", reason: "Discovery cancelled." });
    const limited = discoveryProfile(); limited.limits.maxActions = 3;
    const result = await runAuthDiscovery(limited, { username: "fake", password: "fake" }, createLogger());
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toContain("four login");
  });

  it("closes an in-flight login on cancellation without offering unobserved conditions", async () => {
    const controller = new AbortController();
    const heldServer = createServer((_req, _res) => { controller.abort(); });
    await new Promise<void>(resolve => heldServer.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + (heldServer.address() as AddressInfo).port;
    const profile = discoveryProfile(); profile.auth.loginUrl = origin + "/login";
    profile.navigation.allowedOrigins = [origin]; profile.resources.allowedApiOrigins = [origin];
    try {
      const result = await runAuthDiscovery(profile, { username: VALID_USERNAME, password: VALID_PASSWORD }, createLogger(), controller.signal);
      expect(result).toEqual({ status: "failed", reason: "Discovery cancelled." });
    } finally { heldServer.closeAllConnections(); await new Promise<void>(resolve => heldServer.close(() => resolve())); }
  });

  it("does not offer the login page as an authenticated observation when submission does not navigate", async () => {
    const profile = discoveryProfile();
    profile.auth.submitControl = { role: "textbox", name: "Username" }; // click succeeds without submitting
    const result = await runAuthDiscovery(profile, { username: VALID_USERNAME, password: VALID_PASSWORD }, createLogger());
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toContain("stayed on the login route");
  }, 20000);

  it("observes the real post-login URL and a real visible landmark, ignoring the profile's own (wrong) placeholder success conditions", async () => {
    const profile = discoveryProfile();
    const logDir = mkdtempSync(join(tmpdir(), "autoqa-discovery-test-"));
    const logPath = join(logDir, "discovery.log");
    const logger = createLogger(logPath);

    const result = await runAuthDiscovery(profile, { username: VALID_USERNAME, password: VALID_PASSWORD }, logger);

    expect(result.status).toBe("observed");
    if (result.status !== "observed") return;
    expect(result.observedUrl).toContain("/dashboard-real");
    expect(result.observedUrl).not.toContain("session");
    expect(new RegExp(result.successUrlPattern).test(ORIGIN + "/dashboard-real?session=other")).toBe(true);
    expect(new RegExp(result.successUrlPattern).test(ORIGIN + "/dashboard-real-extra")).toBe(false);
    expect(new RegExp(result.successUrlPattern).test("https://elsewhere.invalid/dashboard-real")).toBe(false);
    expect(new RegExp(result.successUrlPattern).test(ORIGIN.replace("127.0.0.1", "127x0x0x1") + "/dashboard-real")).toBe(false);
    expect(result.candidateSignals.some((s) => s.role === "heading" && s.name === "Real Dashboard")).toBe(true);
    expect(result.candidateSignals.some((s) => s.role === "navigation")).toBe(true);

    // The submitted credential must never appear in any log line this
    // path writes -- proves the "never logged" claim behaviorally, not
    // just by code inspection.
    await new Promise((r) => setTimeout(r, 100)); // pino's async destination needs a tick to flush
    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent).not.toContain(VALID_PASSWORD);
    expect(logContent).not.toContain(VALID_USERNAME);
  }, 30_000);

  it("fails cleanly with a specific reason when auth is not form-login-configured, rather than throwing", async () => {
    const profile = parseProfile({
      schemaVersion: 1,
      id: "discovery-none-auth",
      name: "Test",
      target: { url: `${ORIGIN}/dashboard-real`, environmentKind: "owned-sandbox" },
      navigation: { allowedOrigins: [ORIGIN], allowedPathPrefixes: ["/"] },
      resources: { allowedApiOrigins: [ORIGIN], allowedFormSubmitEndpoints: [] },
      workflows: { allowedWorkflowKinds: ["navigate"] },
      auth: { mode: "none" },
      provider: {
        explorer: { provider: "mock" },
        critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
        providerTimeoutMs: 30000,
      },
      limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
    });

    const result = await runAuthDiscovery(profile, { username: "x", password: "y" }, createLogger());

    expect(result.status).toBe("failed");
  });

  it("the same auth.allowedRequests entry discovery relies on is denied outside the authenticating window -- proves discovery's exception is genuinely narrow, not a standing allowlist", async () => {
    const profile = discoveryProfile();
    const { ActionPolicy } = await import("../../src/safety/action-policy.js");
    const policy = new ActionPolicy(profile);

    const duringLogin = policy.classifyResourceRequest("POST", "/api/login", ORIGIN, "fetch", true);
    expect(duringLogin.decision).toBe("allowed");

    const afterLogin = policy.classifyResourceRequest("POST", "/api/login", ORIGIN, "fetch", false);
    expect(afterLogin.decision).toBe("denied");
  });
});
