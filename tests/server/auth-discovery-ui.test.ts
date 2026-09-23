import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../../src/server/app.js";

const servers: Server[] = [];
let browser: Browser | undefined;
afterEach(async () => {
  await browser?.close(); browser = undefined;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});

async function setup(holdLogin = false) {
  let reachedLogin!: () => void;
  const loginReached = new Promise<void>(r => { reachedLogin = r; });
  const target = createServer((req, res) => {
    if (req.url?.startsWith("/login")) {
      reachedLogin();
      if (holdLogin) return;
      res.setHeader("content-type", "text/html");
      res.end('<h1>Sign in</h1><form onsubmit="event.preventDefault();fetch(\'/session\',{method:\'POST\'}).then(()=>location.href=\'/home?token=fake-callback\')"><input aria-label="Username"><input type="password" aria-label="Password"><button>Login</button></form>');
      return;
    }
    if (req.method === "POST" && req.url === "/session") { res.end("{}"); return; }
    res.setHeader("content-type", "text/html");
    res.end("<header>Demo Person Personal</header><h1>Overview</h1>");
  });
  servers.push(target);
  await new Promise<void>(r => target.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + (target.address() as AddressInfo).port;
  const root = mkdtempSync(join(tmpdir(), "autoqa-discovery-ui-"));
  const profiles = join(root, "profiles"), runs = join(root, "runs"); mkdirSync(profiles);
  const profile = {
    schemaVersion: 1, id: "sandbox", name: "Synthetic sandbox", target: { url: origin + "/home", environmentKind: "owned-sandbox" },
    navigation: { allowedOrigins: [origin], allowedPathPrefixes: ["/"] }, resources: { allowedApiOrigins: [origin], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"], executionMode: "declared" },
    auth: { mode: "form-login", loginUrl: origin + "/login", usernameField: { label: "Username" }, passwordField: { label: "Password" }, submitControl: { role: "button", name: "Login" }, checksVerified: false, successUrlPattern: "never", authenticatedSignal: { role: "navigation" }, allowedRequests: [{ method: "POST", pathname: "/session", origin }] },
    provider: { explorer: { provider: "mock" }, critic: { enabled: true, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 1000 },
    limits: { maxActions: 25, maxModelCalls: 20, maxPages: 5, maxFindings: 5, maxCriticCalls: 5, maxDurationMs: 60000 }
  };
  const profilePath = join(profiles, "sandbox.json");
  writeFileSync(profilePath, JSON.stringify(profile));
  writeFileSync(join(profiles, "sandbox.workflows.json"), JSON.stringify({ schemaVersion: 1, profileId: "sandbox", pages: [], workflows: [] }));
  const ui = await startServer({ profilesDir: profiles, runsDir: runs }); servers.push(ui.server);
  const base = "http://127.0.0.1:" + ui.port;
  return { ui, base, root, profilePath, runs, origin, loginReached };
}

describe("Authentication discovery through the local UI", () => {
  it("guides unverified setup through reviewed discovery and a separate actual auth-only run with transient credentials", async () => {
    const { base, ui, profilePath, runs, origin } = await setup();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(base);
    await page.getByText("Overall: NOT READY", { exact: true }).waitFor();
    expect(await page.locator("#start-btn").isDisabled()).toBe(true);
    expect(await page.locator("#auth-only").isChecked()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator("#ad-username").fill("fake-user");
    await page.locator("#ad-password").fill("fake-password");
    await page.locator("#ad-discover-btn").click();
    expect(await page.locator("#ad-password").inputValue()).toBe("");
    expect(await page.locator("#ad-username").inputValue()).toBe("");
    await page.locator("#ad-result").waitFor({ state: "visible" });
    expect(await page.locator("#ad-signal").textContent()).toContain("heading: Overview");
    expect(await page.locator("#ad-signal").textContent()).not.toContain("Demo Person");
    expect(await page.locator("#ad-observed-url").textContent()).toBe(origin + "/home");
    expect(JSON.parse(readFileSync(profilePath, "utf8")).auth.checksVerified).toBe(false);
    expect(existsSync(runs) ? readdirSync(runs) : []).toHaveLength(0);
    await page.locator("#ad-save-btn").click();
    await page.getByText("Overall: READY", { exact: true }).waitFor();
    expect(await page.locator("#profile-select").inputValue()).toBe("sandbox");
    const saved = readFileSync(profilePath, "utf8");
    expect(saved).not.toContain("fake-password"); expect(saved).not.toContain("fake-callback");
    expect(JSON.parse(saved).auth.authenticatedSignal).toEqual({ role: "heading", name: "Overview" });
    await page.locator("#auth-only").uncheck();
    expect(await page.locator("#start-btn").isDisabled()).toBe(true);
    const refused = await fetch(base + "/api/runs", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": ui.csrfToken }, body: JSON.stringify({ profileId: "sandbox", mode: "demo" }) });
    expect(refused.status).toBe(400);
    await page.locator("#auth-only").check();
    await page.locator("#auth-username").fill("fake-user"); await page.locator("#auth-password").fill("fake-password");
    await page.locator("#start-btn").click();
    await page.waitForFunction(() => document.querySelector("#status-line")?.textContent?.startsWith("Completed"), { timeout: 20000 });
    await page.waitForFunction(() => !(document.querySelector("#start-btn") as HTMLButtonElement).disabled);
    const data = await (await fetch(base + "/api/runs")).json() as { runs: Array<{ runId: string; status: string; usage: { explorer: { requests: number }; critic: { requests: number } } }> };
    expect(data.runs).toHaveLength(1); expect(data.runs[0]!.status).toBe("completed");
    expect(data.runs[0]!.usage.explorer.requests).toBe(0); expect(data.runs[0]!.usage.critic.requests).toBe(0);
    const auth = JSON.parse(readFileSync(join(runs, data.runs[0]!.runId, "authentication.json"), "utf8"));
    expect(auth.status).toBe("success"); expect(auth.actions).toBe(4);
    expect(auth.authenticatedUrl).toBe(origin + "/home");
    await page.waitForFunction(() => !(document.querySelector("#start-btn") as HTMLButtonElement).disabled);
    expect(await page.locator("#auth-password").inputValue()).toBe("");
  }, 40000);

  it("cancels discovery on user request, clears local input, and retains unverified conditions", async () => {
    const { base, profilePath, loginReached } = await setup(true);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); await page.goto(base);
    await page.locator("#ad-username").fill("fake-user"); await page.locator("#ad-password").fill("fake-password");
    await page.locator("#ad-discover-btn").click();
    await loginReached;
    await page.locator("#ad-cancel-btn").click();
    await page.getByText("Discovery cancelled. No conditions were saved.", { exact: true }).waitFor();
    expect(await page.locator("#ad-password").inputValue()).toBe("");
    expect(JSON.parse(readFileSync(profilePath, "utf8")).auth.checksVerified).toBe(false);
    expect(await page.locator("#ad-result").isHidden()).toBe(true);
  });

  it("requires CSRF and rejects overlapping discovery/run sessions", async () => {
    const { base, ui, loginReached, profilePath } = await setup(true);
    const url = base + "/api/profiles/sandbox/auth-discovery";
    const body = JSON.stringify({ username: "fake", password: "fake" });
    expect((await fetch(url, { method: "POST", body })).status).toBe(403);
    const controller = new AbortController();
    const pending = fetch(url, { method: "POST", headers: { "x-csrf-token": ui.csrfToken }, body, signal: controller.signal }).catch(() => undefined);
    await loginReached;
    expect((await fetch(url, { method: "POST", headers: { "x-csrf-token": ui.csrfToken }, body })).status).toBe(409);
    // A schema-valid body is required here: the discovery-vs-run overlap
    // check now lives inside RunManager.startRun()'s own synchronous lock
    // prelude (2026-09-23 TOCTOU fix), which only runs after handleStartRun
    // has already parsed/validated the request body -- an empty body would
    // 400 on validation before ever reaching that check.
    expect((await fetch(base + "/api/runs", { method: "POST", headers: { "x-csrf-token": ui.csrfToken }, body: JSON.stringify({ profileId: "sandbox", mode: "demo" }) })).status).toBe(409);
    controller.abort(); await pending;
    expect(JSON.parse(readFileSync(profilePath, "utf8")).auth.checksVerified).toBe(false);
  });
  it("rechecks discovery exclusion after a delayed run request body arrives", async () => {
    const { base, ui, loginReached } = await setup(true);
    let received!: () => void;
    const arrived = new Promise<void>(r => { received = r; });
    ui.server.once("request", received);
    let status!: Promise<number>;
    const held = httpRequest(base + "/api/runs", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": ui.csrfToken } });
    status = new Promise<number>((resolve, reject) => { held.on("response", res => { res.resume(); resolve(res.statusCode!); }); held.on("error", reject); });
    held.write('{"profileId":'); await arrived;
    const controller = new AbortController();
    const discovery = fetch(base + "/api/profiles/sandbox/auth-discovery", { method: "POST", headers: { "x-csrf-token": ui.csrfToken }, body: JSON.stringify({ username: "fake", password: "fake" }), signal: controller.signal }).catch(() => undefined);
    try {
      await loginReached;
      held.end('"sandbox","mode":"demo","authenticationOnly":true}');
      expect(await status).toBe(409);
    } finally { controller.abort(); held.destroy(); await discovery; }
  });
});
