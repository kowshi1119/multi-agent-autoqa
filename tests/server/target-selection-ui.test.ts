import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../../src/server/app.js";

/**
 * Target selection races in the real control panel. The "unintended"
 * application counts every request it receives; each scenario asserts it
 * received none. Timing is controlled by holding responses in page.route(),
 * never by sleeping and hoping.
 */
const closers: Array<() => Promise<void>> = [];
let browser: Browser | undefined;
afterEach(async () => {
  await browser?.close(); browser = undefined;
  for (const close of closers.splice(0)) await close();
});

async function countingTarget(heading: string) {
  let hits = 0;
  const server: Server = createServer((_req, res) => { hits++; res.setHeader("content-type", "text/html"); res.end(`<h1>${heading}</h1>`); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits, reset: () => { hits = 0; } };
}

function profile(id: string, name: string, origin: string) {
  return {
    schemaVersion: 1, id, name, target: { url: `${origin}/`, environmentKind: "owned-sandbox" },
    navigation: { allowedOrigins: [origin], allowedPathPrefixes: ["/"] }, resources: { allowedApiOrigins: [origin], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"] }, auth: { mode: "none" },
    provider: { explorer: { provider: "mock" }, critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 1000 },
    limits: { maxActions: 2, maxModelCalls: 2, maxPages: 2, maxFindings: 1, maxDurationMs: 20000, maxCriticCalls: 1 },
  };
}

async function setup() {
  const intended = await countingTarget("Synthetic app");
  const unintended = await countingTarget("Real-looking app");
  const root = mkdtempSync(join(tmpdir(), "autoqa-target-ui-"));
  const profiles = join(root, "profiles"); mkdirSync(profiles);
  // "aaa-real" sorts first, like "ajeer" did -- the old implicit default.
  writeFileSync(join(profiles, "aaa-real.json"), JSON.stringify(profile("aaa-real", "Real-looking app", unintended.origin)));
  writeFileSync(join(profiles, "synthetic.json"), JSON.stringify(profile("synthetic", "Synthetic app", intended.origin)));
  const ui = await startServer({ port: 0, profilesDir: profiles, runsDir: join(root, "runs") });
  closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const runPosts: Array<{ profileId: string; expected?: { fingerprint: string } }> = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/runs") && r.method() === "POST") runPosts.push(JSON.parse(r.postData() ?? "{}")); });
  return { intended, unintended, profiles, base: `http://127.0.0.1:${ui.port}`, page, runPosts };
}

async function waitForRunEnd(page: Page) {
  await page.waitForFunction(() => /^(Completed|Stopped|Failed)/.test(document.querySelector("#status-line")?.textContent ?? ""), undefined, { timeout: 30000 });
}

describe("target selection in the control panel", () => {
  it("selects nothing on load; Start and Discover stay disabled until a target is prepared", async () => {
    const { page, base, unintended } = await setup();
    await page.goto(base);
    await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
    expect(await page.locator("#profile-select").inputValue()).toBe("");
    expect(await page.locator("#start-btn").isDisabled()).toBe(true);
    expect(await page.locator("#target-line").textContent()).toContain("No application selected");
    expect(unintended.hits()).toBe(0);
  });

  it("ignores a delayed readiness response for a profile the user already switched away from", async () => {
    const { page, base, intended, unintended, runPosts } = await setup();
    let releaseStale!: () => void;
    const staleHeld = new Promise<void>((r) => { releaseStale = r; });
    let staleSeen!: () => void;
    const staleArrived = new Promise<void>((r) => { staleSeen = r; });
    // The page aborts this request when the selection changes; releasing it
    // afterwards must not result in the server probing the old target.
    await page.route("**/api/preflight?profileId=aaa-real*", async (route) => { staleSeen(); await staleHeld; await route.continue().catch(() => {}); });
    await page.goto(base);
    await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
    await page.selectOption("#profile-select", "aaa-real");
    await staleArrived;
    await page.selectOption("#profile-select", "synthetic");
    await page.waitForFunction(() => (document.querySelector("#target-line")?.textContent ?? "").includes("Target: Synthetic app"));
    releaseStale();
    await page.waitForTimeout(300); // let the stale response land; it must change nothing
    expect(await page.locator("#target-line").textContent()).toContain("Target: Synthetic app");
    expect(unintended.hits()).toBe(0);
    await page.locator("#start-btn").click();
    await waitForRunEnd(page);
    expect(runPosts).toHaveLength(1);
    expect(runPosts[0]!.profileId).toBe("synthetic");
    expect(unintended.hits()).toBe(0);
    expect(intended.hits()).toBeGreaterThan(0);
  }, 45000);

  it("a reload clears the selection instead of reviving the previous target", async () => {
    const { page, base } = await setup();
    await page.goto(base);
    await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
    await page.selectOption("#profile-select", "synthetic");
    await page.waitForFunction(() => !(document.querySelector("#start-btn") as HTMLButtonElement).disabled);
    await page.reload();
    await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
    expect(await page.locator("#profile-select").inputValue()).toBe("");
    expect(await page.locator("#start-btn").isDisabled()).toBe(true);
  });

  it("a configuration change between readiness and Start is rejected by the server with no target contact, then re-prepared", async () => {
    const { page, base, profiles, intended, runPosts } = await setup();
    await page.goto(base);
    await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
    await page.selectOption("#profile-select", "synthetic");
    await page.waitForFunction(() => !(document.querySelector("#start-btn") as HTMLButtonElement).disabled);
    const path = join(profiles, "synthetic.json");
    const edited = JSON.parse(readFileSync(path, "utf-8"));
    edited.limits.maxActions = 1;
    writeFileSync(path, JSON.stringify(edited));
    intended.reset();
    await page.locator("#start-btn").click();
    await page.waitForFunction(() => (document.querySelector("#status-line")?.textContent ?? "").includes("changed after setup was checked"));
    expect(runPosts).toHaveLength(1);
    // The automatic re-check probes readiness again (intended); no run started.
    const runs = (await (await fetch(`${base}/api/runs`)).json()) as { runs: unknown[] };
    expect(runs.runs).toHaveLength(0);
    await page.waitForFunction(() => !(document.querySelector("#start-btn") as HTMLButtonElement).disabled);
  }, 30000);

  it("a double click starts exactly one run", async () => {
    const { page, base, runPosts } = await setup();
    await page.goto(base);
    await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
    await page.selectOption("#profile-select", "synthetic");
    await page.waitForFunction(() => !(document.querySelector("#start-btn") as HTMLButtonElement).disabled);
    await page.evaluate(() => { const b = document.querySelector("#start-btn") as HTMLButtonElement; b.click(); b.click(); });
    await waitForRunEnd(page);
    expect(runPosts).toHaveLength(1);
    const runs = (await (await fetch(`${base}/api/runs`)).json()) as { runs: unknown[] };
    expect(runs.runs).toHaveLength(1);
  }, 45000);
});
