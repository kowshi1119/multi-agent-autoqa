import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logger.js";
import { parseProfile, type ProjectProfile } from "../../src/profiles/schema.js";
import { FormLoginBootstrap, NoAuthBootstrap, selectSessionBootstrap } from "../../src/auth/session-bootstrap.js";

let server: Server;
let ORIGIN: string;
let browser: Browser;
const VALID_USERNAME = "admin";
const VALID_PASSWORD = "s3cr3t-test-password";

const TRICK_USERNAME = "trickster";
const TRICK_PASSWORD = "trick-pw-not-real";

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
      if (u === ${JSON.stringify(VALID_USERNAME)} && p === ${JSON.stringify(VALID_PASSWORD)}) {
        window.location.href = "/dashboard";
      } else if (u === ${JSON.stringify(TRICK_USERNAME)} && p === ${JSON.stringify(TRICK_PASSWORD)}) {
        // Lands somewhere that happens to render the same authenticatedSignal
        // but is NOT the profile's declared successUrlPattern destination --
        // proves the fix checks the URL, not signal-visibility alone.
        window.location.href = "/fake-dashboard";
      } else {
        document.body.insertAdjacentHTML("beforeend", "<p id='error'>Invalid credentials</p>");
      }
    });
  </script>
</body></html>`;

const DASHBOARD_PAGE_HTML = `<!doctype html><html><body><h1>Dashboard</h1></body></html>`;
// A page reachable at an URL the profile's successUrlPattern does NOT
// match, but which renders the exact same "Dashboard" heading the real
// success page does -- signal-visibility alone would wrongly call this a
// successful login.
const FAKE_SUCCESS_PAGE_HTML = `<!doctype html><html><body><h1>Dashboard</h1></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/dashboard") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(DASHBOARD_PAGE_HTML);
    }
    if (req.url === "/fake-dashboard") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(FAKE_SUCCESS_PAGE_HTML);
    }
    // Deliberately never responds -- lets a test hold `page.goto()` in
    // flight indefinitely to prove Stop interrupts it mid-call rather than
    // waiting for either a response or the navigation's own timeout.
    if (req.url === "/login-stall") return;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(LOGIN_PAGE_HTML);
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

function loginProfile(overrides: (raw: Record<string, unknown>) => void = () => {}): ProjectProfile {
  const raw = {
    schemaVersion: 1,
    id: "test-login",
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

describe("selectSessionBootstrap", () => {
  it("returns NoAuthBootstrap for auth.mode = none", () => {
    const profile = loginProfile((raw) => {
      (raw["auth"] as Record<string, unknown>) = { mode: "none" };
    });
    expect(selectSessionBootstrap(profile)).toBeInstanceOf(NoAuthBootstrap);
  });

  it("returns FormLoginBootstrap for auth.mode = form-login", () => {
    expect(selectSessionBootstrap(loginProfile())).toBeInstanceOf(FormLoginBootstrap);
  });
});

describe("FormLoginBootstrap (real browser, synthetic login page)", () => {
  it("succeeds with valid credentials and the authenticated signal becomes visible", async () => {
    const profile = loginProfile();
    const context = await browser.newContext();
    const page = await context.newPage();
    const bootstrap = new FormLoginBootstrap();

    const result = await bootstrap.establish(context, page, profile, { username: VALID_USERNAME, password: VALID_PASSWORD }, createLogger());

    expect(result.status).toBe("success");
    await context.close();
  });

  it("fails explicitly (never throws) with wrong credentials -- not misclassified as a product defect", async () => {
    const profile = loginProfile();
    const context = await browser.newContext();
    const page = await context.newPage();
    const bootstrap = new FormLoginBootstrap();

    const result = await bootstrap.establish(context, page, profile, { username: "admin", password: "wrong-password" }, createLogger());

    // Wrong credentials leave the login page in place -- the URL never
    // matches successUrlPattern at all, which is the more precise failure
    // reason (the old code never checked this and could only ever report
    // "missing-signal" here).
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toBe("success-url-mismatch");
    await context.close();
  });

  it("fails with success-url-mismatch when the authenticatedSignal is visible but the URL never matched successUrlPattern (a look-alike page)", async () => {
    const profile = loginProfile();
    const context = await browser.newContext();
    const page = await context.newPage();
    const bootstrap = new FormLoginBootstrap();

    const result = await bootstrap.establish(context, page, profile, { username: TRICK_USERNAME, password: TRICK_PASSWORD }, createLogger());

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toBe("success-url-mismatch");
    expect(page.url()).toContain("/fake-dashboard");
    await context.close();
  });

  it("fails explicitly when no credentials are supplied at all", async () => {
    const profile = loginProfile();
    const context = await browser.newContext();
    const page = await context.newPage();
    const bootstrap = new FormLoginBootstrap();

    const result = await bootstrap.establish(context, page, profile, undefined, createLogger());

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toBe("invalid-credentials");
    await context.close();
  });

  it("fails with missing-signal when login reaches the success URL but the configured signal never appears (a wrong/stale locator)", async () => {
    const profile = loginProfile((raw) => {
      // The real /dashboard page only ever renders an <h1>Dashboard</h1> --
      // this profile looks for a signal that will never be there, exercising
      // the "success-looking URL, no real authenticated-page confirmation"
      // path without needing a second synthetic page.
      (raw["auth"] as Record<string, unknown>)["authenticatedSignal"] = { role: "heading", name: "Never Appears" };
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const bootstrap = new FormLoginBootstrap();

    const result = await bootstrap.establish(context, page, profile, { username: VALID_USERNAME, password: VALID_PASSWORD }, createLogger());

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toBe("missing-signal");
    expect(page.url()).toContain("/dashboard");
    await context.close();
  });

  it("§8a fix (2026-09-14 addendum): an already-aborted signal returns cancelled without attempting any Playwright action", async () => {
    const profile = loginProfile();
    const context = await browser.newContext();
    const page = await context.newPage();
    const bootstrap = new FormLoginBootstrap();
    const controller = new AbortController();
    controller.abort();

    const gotoSpy = vi.spyOn(page, "goto");
    const result = await bootstrap.establish(context, page, profile, { username: VALID_USERNAME, password: VALID_PASSWORD }, createLogger(), controller.signal);

    expect(result).toEqual({ status: "failed", reason: "cancelled" });
    expect(gotoSpy).not.toHaveBeenCalled();
    await context.close();
  });

  it("2026-09-15 cancellation-bound fix: Stop mid-sequence (not just mid-retry) halts within one step's own timeout, wall-clock measured -- the fill step never starts once the signal aborts right after goto()", async () => {
    const profile = loginProfile();
    const context = await browser.newContext();
    const page = await context.newPage();
    const bootstrap = new FormLoginBootstrap();
    const controller = new AbortController();

    // Aborts as a side effect of the FIRST step (goto) actually completing --
    // proves the check fires between steps, not just once at entry, and
    // that no later step (fill/click/wait, each with its own up-to-15s or
    // up-to-10s timeout) ever starts.
    const realGoto = page.goto.bind(page);
    const gotoSpy = vi.spyOn(page, "goto").mockImplementation(async (...args: Parameters<typeof page.goto>) => {
      const result = await realGoto(...args);
      controller.abort();
      return result;
    });
    // Playwright constructs a fresh Locator instance per call -- there is no
    // importable class to spy on directly. Grab a real instance's own
    // prototype first (shared by every Locator this page creates), mirroring
    // the same idiom tests/validator-auth.test.ts already uses for
    // BrowserContext.
    const locatorProto = Object.getPrototypeOf(page.locator("body")) as { fill: (...args: unknown[]) => Promise<void> };
    const fillSpy = vi.spyOn(locatorProto, "fill");

    const startedAt = Date.now();
    const result = await bootstrap.establish(context, page, profile, { username: VALID_USERNAME, password: VALID_PASSWORD }, createLogger(), controller.signal);
    const elapsedMs = Date.now() - startedAt;

    expect(result).toEqual({ status: "failed", reason: "cancelled" });
    expect(gotoSpy).toHaveBeenCalledTimes(1);
    expect(fillSpy).not.toHaveBeenCalled();
    // Well under LOGIN_NAV_TIMEOUT_MS (15s) -- if the old ~80s-summed
    // behavior were still in effect, a subsequent step's own fresh timeout
    // would need to elapse before this resolved.
    expect(elapsedMs).toBeLessThan(5_000);

    await context.close();
  }, 20_000);

  it("2026-09-16 cancellation fix: Stop DURING an already-in-flight step (not just between steps) interrupts it directly -- reproduces the real-Chromium probe's own scenario (Stop during a long-running Playwright call returned success ~9.9s later) for the login path specifically", async () => {
    const profile = loginProfile((raw) => {
      (raw.auth as Record<string, unknown>).loginUrl = `${ORIGIN}/login-stall`;
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const bootstrap = new FormLoginBootstrap();
    const controller = new AbortController();

    // The server never responds to /login-stall, so this goto() is
    // genuinely in-flight (not merely about to start) when abort() fires.
    setTimeout(() => controller.abort(), 500);

    const startedAt = Date.now();
    const result = await bootstrap.establish(context, page, profile, { username: VALID_USERNAME, password: VALID_PASSWORD }, createLogger(), controller.signal);
    const elapsedMs = Date.now() - startedAt;

    expect(result).toEqual({ status: "failed", reason: "cancelled" });
    // Genuinely interrupted, not bounded by LOGIN_NAV_TIMEOUT_MS (15s) --
    // this is the property the prior "checked between steps only" fix did
    // NOT provide: an already-in-flight goto() used to run to its own full
    // timeout regardless of Stop.
    expect(elapsedMs).toBeLessThan(3_000);

    await context.close();
  }, 20_000);
});
