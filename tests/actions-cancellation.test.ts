import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeAction } from "../src/actions.js";
import { createLogger } from "../src/logger.js";
import { parseProfile } from "../src/profiles/schema.js";
import { profileToAppConfig } from "../src/profiles/to-app-config.js";
import { ActionPolicy } from "../src/safety/action-policy.js";

/**
 * §Cancellation fix (2026-09-16): a real-Chromium probe found requesting
 * Stop during a 10-second "wait" action returned success ~9.9s later --
 * every existing `signal?.aborted` check in this codebase was a snapshot
 * check at the top of a function/loop iteration, never wired into the
 * actual in-flight Playwright call. These tests prove executeAction() now
 * genuinely interrupts an already-in-flight action for every action type
 * that can run long, wall-clock measured against a real disposable local
 * HTTP server (self-hosted-real-app, with a real ActionPolicy where
 * relevant -- never local-fixture, which never constructs one) rather than
 * asserted from an assumed number.
 */

let server: Server;
let ORIGIN: string;
let browser: Browser;

const PAGE_HTML = `<!doctype html><html><body>
  <h1>Home</h1>
  <a href="/next" id="next-link">Next page</a>
  <button id="never-visible-trigger" style="display:none">Hidden forever</button>
</body></html>`;

const NEXT_PAGE_HTML = `<!doctype html><html><body><h1>Next</h1></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/next") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(NEXT_PAGE_HTML);
    }
    // Deliberately never responds -- holds a goto()/reload() in flight
    // indefinitely so a test can prove Stop interrupts it mid-call.
    if (req.url === "/stall") return;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(PAGE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const port = (server.address() as AddressInfo).port;
  ORIGIN = `http://localhost:${port}`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function testProfile() {
  return parseProfile({
    schemaVersion: 1,
    id: "test-cancellation",
    name: "Test",
    target: { url: `${ORIGIN}/`, environmentKind: "self-hosted-real-app" },
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
}

describe("executeAction() cancellation -- genuine mid-action interruption, wall-clock measured", () => {
  it("wait: aborting mid-wait returns promptly instead of running the full clamped duration (the exact scenario the probe found broken)", async () => {
    const profile = testProfile();
    const config = profileToAppConfig(profile);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const logger = createLogger();
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 500);

    const startedAt = Date.now();
    const result = await executeAction(page, { type: "wait", milliseconds: 10_000 }, config, logger, undefined, undefined, [], controller.signal);
    const elapsedMs = Date.now() - startedAt;

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") expect(result.reason).toContain("CANCELLED");
    expect(elapsedMs).toBeLessThan(2_000);

    await context.close();
  }, 20_000);

  it("navigate: aborting mid-navigation (server never responds) interrupts the goto() itself, not just prevents starting a new action", async () => {
    const profile = testProfile();
    const config = profileToAppConfig(profile);
    const policy = new ActionPolicy(profile);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const logger = createLogger();
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 500);

    const startedAt = Date.now();
    const result = await executeAction(page, { type: "navigate", url: `${ORIGIN}/stall` }, config, logger, undefined, policy, [], controller.signal);
    const elapsedMs = Date.now() - startedAt;

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") expect(result.reason).toContain("CANCELLED");
    // Well under NAVIGATION_TIMEOUT_MS (15s) -- the server never responds at
    // all, so only genuine signal-driven interruption can end this quickly.
    expect(elapsedMs).toBeLessThan(3_000);

    await context.close();
  }, 20_000);

  it("reload: aborting mid-reload (route intercepted, never fulfilled) interrupts the reload() itself", async () => {
    const profile = testProfile();
    const config = profileToAppConfig(profile);
    const context = await browser.newContext();
    const page = await context.newPage();
    // Real initial navigation completes normally -- only installed AFTER
    // this does the route handler affect the reload triggered below.
    await page.goto(`${ORIGIN}/`);
    // Never calls route.fulfill()/continue()/abort() -- the reload's own
    // request hangs indefinitely until the signal interrupts it.
    await page.route("**/*", () => {});

    const logger = createLogger();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);

    const startedAt = Date.now();
    const result = await executeAction(page, { type: "reload" }, config, logger, undefined, undefined, [], controller.signal);
    const elapsedMs = Date.now() - startedAt;

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") expect(result.reason).toContain("CANCELLED");
    expect(elapsedMs).toBeLessThan(3_000);

    await context.close();
  }, 20_000);

  it("locator resolution/click: aborting while waiting for a control that never becomes visible interrupts the wait, not just skips the click", async () => {
    const profile = testProfile();
    const config = profileToAppConfig(profile);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const logger = createLogger();
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 500);

    const startedAt = Date.now();
    const result = await executeAction(
      page,
      { type: "click", target: { testId: "never-visible-trigger" } },
      config,
      logger,
      undefined,
      undefined,
      [],
      controller.signal
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") expect(result.reason).toContain("CANCELLED");
    // Well under LOCATOR_TIMEOUT_MS (5s).
    expect(elapsedMs).toBeLessThan(2_500);

    await context.close();
  }, 20_000);

  it("an already-aborted signal at entry still returns immediately without attempting any Playwright call (fast-path preserved)", async () => {
    const profile = testProfile();
    const config = profileToAppConfig(profile);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const logger = createLogger();
    const controller = new AbortController();
    controller.abort();

    const result = await executeAction(page, { type: "wait", milliseconds: 10_000 }, config, logger, undefined, undefined, [], controller.signal);

    expect(result).toEqual({ outcome: "blocked", reason: "CANCELLED: stop requested before this action began" });

    await context.close();
  });
});
