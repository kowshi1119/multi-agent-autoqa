import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FormLoginBootstrap, type SessionBootstrap } from "../../src/auth/session-bootstrap.js";
import { createLogger } from "../../src/logger.js";
import { parseProfile, type ProjectProfile } from "../../src/profiles/schema.js";
import { profileToAppConfig } from "../../src/profiles/to-app-config.js";
import { runPipeline } from "../../src/run-pipeline.js";
import type { RunProgressEvent } from "../../src/progress.js";

/**
 * Deterministic regression coverage for the confirmed bug (2026-09-21):
 * Orchestrator#initialize()'s early-return branches (login failure/
 * cancellation, initial-navigation failure/cancellation, post-auth budget
 * exhaustion) transitioned to a terminal RunContext state but never called
 * this.progress() -- run()'s own while loop is the only other place a
 * terminal event is emitted, and its condition is already false once
 * initialize() itself returns a terminal ctx, so that loop body never runs.
 * A Stop landing during login or initial navigation left run-summary.json
 * correct but silently dropped the terminal progress event the UI relies
 * on. These tests force cancellation at each exact point deterministically
 * (via a wrapped SessionBootstrap / a pre-aborted signal reaching goto()),
 * never a sleep-based race like the RunManager-level integration test.
 */

let server: Server;
let ORIGIN: string;
const VALID_USERNAME = "admin";
const VALID_PASSWORD = "s3cr3t-test-password";

const DASHBOARD_HTML = `<!doctype html><html><body><h1>Dashboard</h1></body></html>`;

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

function loginProfile(): ProjectProfile {
  return parseProfile({
    schemaVersion: 1,
    id: "test-cancellation-progress",
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
  });
}

function freshRunDir(): string {
  return mkdtempSync(join(tmpdir(), "autoqa-cancellation-progress-"));
}

describe("Orchestrator#initialize() terminal progress events on cancellation (deterministic, not a sleep race)", () => {
  it("emits a terminal 'stopped' progress event when Stop lands during login", async () => {
    const profile = loginProfile();
    const config = profileToAppConfig(profile);
    const logger = createLogger();
    logger.level = "silent";
    const controller = new AbortController();
    const realBootstrap = new FormLoginBootstrap();
    // Aborts BEFORE the real attempt even starts -- FormLoginBootstrap's
    // first line checks signal?.aborted and returns {status:"failed",
    // reason:"cancelled"} immediately, deterministically hitting
    // Orchestrator#initialize()'s login-cancellation branch every time.
    const sessionBootstrap: SessionBootstrap = {
      establish: async (context, page, prof, credentials, log, signal, budget) => {
        controller.abort();
        return realBootstrap.establish(context, page, prof, credentials, log, signal, budget);
      },
    };

    const events: RunProgressEvent[] = [];
    const result = await runPipeline({
      config,
      runId: "test-run-login-cancel",
      runDir: freshRunDir(),
      logger,
      headless: true,
      onProgress: (event) => events.push(event),
      sessionAuth: { sessionBootstrap, profile, credentials: { username: VALID_USERNAME, password: VALID_PASSWORD } },
      abortSignal: controller.signal,
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]!.phase).toBe("stopped");
    expect(result.finalCtx.stopReason).toContain("CANCELLED");
  }, 30_000);

  it("emits a terminal 'stopped' progress event when Stop lands right after login succeeds, before initial navigation", async () => {
    const profile = loginProfile();
    const config = profileToAppConfig(profile);
    const logger = createLogger();
    logger.level = "silent";
    const controller = new AbortController();
    const realBootstrap = new FormLoginBootstrap();
    // Lets the real login complete successfully, THEN aborts -- by the time
    // Orchestrator#initialize() reaches page.goto() for initial navigation,
    // the signal is already aborted, deterministically hitting the
    // initial-navigation-cancellation branch (not the login one).
    const sessionBootstrap: SessionBootstrap = {
      establish: async (context, page, prof, credentials, log, signal, budget) => {
        const result = await realBootstrap.establish(context, page, prof, credentials, log, signal, budget);
        controller.abort();
        return result;
      },
    };

    const events: RunProgressEvent[] = [];
    const result = await runPipeline({
      config,
      runId: "test-run-nav-cancel",
      runDir: freshRunDir(),
      logger,
      headless: true,
      onProgress: (event) => events.push(event),
      sessionAuth: { sessionBootstrap, profile, credentials: { username: VALID_USERNAME, password: VALID_PASSWORD } },
      abortSignal: controller.signal,
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]!.phase).toBe("stopped");
    expect(result.finalCtx.stopReason).toContain("CANCELLED");
  }, 30_000);
});
