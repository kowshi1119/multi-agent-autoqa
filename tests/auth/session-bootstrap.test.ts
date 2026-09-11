import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    res.writeHead(200, { "Content-Type": "text/html" });
    if (req.url === "/dashboard") return res.end(DASHBOARD_PAGE_HTML);
    if (req.url === "/fake-dashboard") return res.end(FAKE_SUCCESS_PAGE_HTML);
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
});
