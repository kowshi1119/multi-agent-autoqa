import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FormLoginBootstrap } from "../src/auth/session-bootstrap.js";
import { BrowserManager } from "../src/browser/browser.js";
import { createLogger } from "../src/logger.js";
import { createHttpFailureOracle } from "../src/oracles/http-failure.js";
import { parseProfile, type ProjectProfile } from "../src/profiles/schema.js";
import { profileToAppConfig } from "../src/profiles/to-app-config.js";
import type { Finding } from "../src/types.js";
import { Validator } from "../src/validator.js";

let server: Server;
let ORIGIN: string;
const VALID_USERNAME = "admin";
const VALID_PASSWORD = "s3cr3t-test-password";
let loginPostCount = 0;

const DASHBOARD_HTML = `<!doctype html><html><body>
  <h1>Dashboard</h1>
  <button id="trigger">Trigger</button>
  <script>
    document.getElementById("trigger").addEventListener("click", function () {
      fetch("/api/fail", { method: "POST" });
    });
  </script>
</body></html>`;

function loginPageHtml(): string {
  return `<!doctype html><html><body>
  <form id="login-form">
    <input id="u" name="username" aria-label="Username" />
    <input id="p" name="password" type="password" aria-label="Password" />
    <button type="submit" id="submit">Login</button>
  </form>
  <script>
    document.getElementById("login-form").addEventListener("submit", function (e) {
      e.preventDefault();
      fetch("/login-attempted", { method: "POST" });
      var u = document.getElementById("u").value;
      var p = document.getElementById("p").value;
      if (u === ${JSON.stringify(VALID_USERNAME)} && p === ${JSON.stringify(VALID_PASSWORD)}) {
        window.location.href = "/dashboard";
      }
    });
  </script>
</body></html>`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/login-attempted") {
      loginPostCount += 1;
      res.writeHead(200);
      return res.end();
    }
    if (req.method === "POST" && req.url === "/api/fail") {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end("{}");
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    if (req.url === "/dashboard") return res.end(DASHBOARD_HTML);
    res.end(loginPageHtml());
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const port = (server.address() as AddressInfo).port;
  ORIGIN = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function loginProfile(overrides: (raw: Record<string, unknown>) => void = () => {}): ProjectProfile {
  const raw = {
    schemaVersion: 1,
    id: "test-validator-auth",
    name: "Test",
    target: { url: `${ORIGIN}/dashboard`, environmentKind: "self-hosted-real-app" },
    navigation: { allowedOrigins: [ORIGIN], allowedPathPrefixes: ["/"] },
    resources: { allowedApiOrigins: [ORIGIN], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"] },
    auth: {
      mode: "form-login",
      loginUrl: `${ORIGIN}/login`,
      usernameField: { role: "textbox", name: "Username" },
      passwordField: { label: "Password" },
      submitControl: { role: "button", name: "Login" },
      successUrlPattern: ".*/dashboard",
      authenticatedSignal: { role: "heading", name: "Dashboard" },
    },
    provider: {
      explorer: { provider: "mock" },
      critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
      providerTimeoutMs: 30000,
    },
    limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
  };
  overrides(raw);
  return parseProfile(raw);
}

function testFinding(): Finding {
  return {
    id: "FINDING-AUTH-TEST",
    title: "t",
    status: "suspected",
    category: "network",
    pageId: "PAGE-TEST",
    url: `${ORIGIN}/dashboard`,
    pathname: "/dashboard",
    expected: "0 new HTTP 5xx responses",
    actual: "1 new HTTP 5xx response",
    oracle: { oracleId: "http-failure", suspicious: true, expected: "0 new HTTP 5xx responses", actual: "1 new HTTP 5xx response", details: { newFailures: [{ method: "POST", url: `${ORIGIN}/api/fail`, status: 500 }] } },
    steps: [{ number: 1, action: { type: "click", target: { role: "button", name: "Trigger" } }, timestamp: new Date().toISOString() }],
    reproduction: { attempts: 0, successes: 0 },
    occurrenceCount: 1,
    evidence: [],
    evidenceLevel: "L3",
    reportDisposition: "needs_human",
  };
}

describe("Validator authenticates per attempt and reuses storageState (Phase 4 Milestone A3)", () => {
  it("establishes a fresh authenticated session per attempt and reproduces the finding", async () => {
    loginPostCount = 0;
    const profile = loginProfile();
    const config = profileToAppConfig(profile);
    const logger = createLogger();
    const browserManager = new BrowserManager(config, logger, true);
    await browserManager.launch();
    const sessionBootstrap = new FormLoginBootstrap();
    const establishSpy = vi.spyOn(sessionBootstrap, "establish");

    const evidenceDir = mkdtempSync(join(tmpdir(), "autoqa-validator-auth-test-"));
    const validator = new Validator({
      browserManager,
      config,
      oracles: [createHttpFailureOracle()],
      logger,
      evidenceDir,
      sessionAuth: { sessionBootstrap, profile, credentials: { username: VALID_USERNAME, password: VALID_PASSWORD } },
    });

    const outcome = await validator.validate(testFinding());
    await browserManager.close();

    expect(outcome.attempts.length).toBe(3);
    expect(outcome.attempts.every((a) => a.reproduced)).toBe(true);
    // Attempt 1 has no carried-over storageState (first real login this
    // Validator run), so establish() is called for attempt 1. Attempts 2/3
    // reuse the caller-supplied storageState if provided -- this test
    // doesn't pass one in (that's the Orchestrator's job, tested via the
    // spy count below matching "no storageState means a real login per
    // attempt"), so every attempt calls establish() once each.
    expect(establishSpy).toHaveBeenCalledTimes(3);
  }, 30_000);

  it("reuses a supplied storageState instead of re-logging in when the signal verifies, falling back to a real login only when it doesn't", async () => {
    const profile = loginProfile();
    const config = profileToAppConfig(profile);
    const logger = createLogger();
    const browserManager = new BrowserManager(config, logger, true);
    await browserManager.launch();

    // First, log in for real once to obtain a genuine authenticated storageState.
    const bootstrapForSetup = new FormLoginBootstrap();
    const session = await browserManager.newPageSession(undefined, undefined, {
      sessionBootstrap: bootstrapForSetup,
      profile,
      credentials: { username: VALID_USERNAME, password: VALID_PASSWORD },
    });
    const storageState = await session.context.storageState();
    await browserManager.closeSession(session);

    const sessionBootstrap = new FormLoginBootstrap();
    const establishSpy = vi.spyOn(sessionBootstrap, "establish");

    const evidenceDir = mkdtempSync(join(tmpdir(), "autoqa-validator-auth-reuse-test-"));
    const validator = new Validator({
      browserManager,
      config,
      oracles: [createHttpFailureOracle()],
      logger,
      evidenceDir,
      sessionAuth: { sessionBootstrap, profile, credentials: { username: VALID_USERNAME, password: VALID_PASSWORD }, storageState },
    });

    const outcome = await validator.validate(testFinding());
    await browserManager.close();

    expect(outcome.attempts.every((a) => a.reproduced)).toBe(true);
    // The supplied storageState verifies successfully on every fresh
    // context (protected-page-accessibility check passes), so the full
    // login sequence is never re-run.
    expect(establishSpy).not.toHaveBeenCalled();
  }, 30_000);

  it("marks an attempt tooling-blocked (never reproduced) when login repeatedly fails, bounded rather than looping", async () => {
    const profile = loginProfile();
    const config = profileToAppConfig(profile);
    // Scoped to 1 outer validation attempt so this test exercises exactly
    // MAX_LOGIN_ATTEMPTS (2) bounded real login attempts against wrong
    // credentials -- not 2 attempts x 3 validation retries -- while still
    // proving the bounded-retry, never-loops-forever, never-reproduces
    // behavior.
    config.validation.attempts = 1;
    config.validation.minimumSuccesses = 1;
    const logger = createLogger();
    const browserManager = new BrowserManager(config, logger, true);
    await browserManager.launch();

    const evidenceDir = mkdtempSync(join(tmpdir(), "autoqa-validator-auth-fail-test-"));
    const validator = new Validator({
      browserManager,
      config,
      oracles: [createHttpFailureOracle()],
      logger,
      evidenceDir,
      sessionAuth: { sessionBootstrap: new FormLoginBootstrap(), profile, credentials: { username: "wrong", password: "wrong" } },
    });

    const outcome = await validator.validate(testFinding());
    await browserManager.close();

    expect(outcome.attempts.every((a) => a.reproduced === false)).toBe(true);
    expect(outcome.attempts.every((a) => a.toolingBlocked?.includes("AUTH_FAILED"))).toBe(true);
    expect(outcome.finding.status).not.toBe("validated");
  }, 60_000);

  it("closes the newly created context when authentication ultimately fails (never leaks an unusable session)", async () => {
    const profile = loginProfile();
    const config = profileToAppConfig(profile);
    const logger = createLogger();
    const browserManager = new BrowserManager(config, logger, true);
    await browserManager.launch();

    // Playwright constructs BrowserContext instances dynamically -- there is
    // no importable class to spy on directly. Grab a real instance's own
    // prototype first (shared by every context this Browser creates), then
    // spy on that.
    const probe = await browserManager.newPageSession();
    const contextProto = Object.getPrototypeOf(probe.context) as { close: () => Promise<void> };
    await browserManager.closeSession(probe);

    const closeSpy = vi.spyOn(contextProto, "close");
    const callsBefore = closeSpy.mock.calls.length;

    await expect(
      browserManager.newPageSession(undefined, undefined, {
        sessionBootstrap: new FormLoginBootstrap(),
        profile,
        credentials: { username: "wrong", password: "wrong" },
      })
    ).rejects.toThrow();

    expect(closeSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    closeSpy.mockRestore();
    await browserManager.close();
  }, 60_000);
});
