import { chromium, type Browser } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { startServer } from "../../src/server/app.js";
import { suiteEnvironment } from "../helpers/suite-env.js";

let server: AuthFixtureServer | undefined;
let browser: Browser | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await browser?.close(); browser = undefined;
  await server?.close(); server = undefined;
  for (const c of closers.splice(0)) await c();
});

describe("Start explains missing input instead of sending a request the server must refuse", () => {
  it("asks for credentials and for workflow names (not a file path), sending nothing", async () => {
    server = await startAuthFixtureServer();
    const env = suiteEnvironment(server.origin);
    const ui = await startServer({ port: 0, profilesDir: env.profilesDir, runsDir: env.runsDir });
    closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    let runPosts = 0;
    page.on("request", (r) => { if (r.url().endsWith("/api/runs") && r.method() === "POST") runPosts++; });
    await page.goto(`http://127.0.0.1:${ui.port}`);
    await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
    await page.locator("#profile-select").selectOption("demo");
    await page.waitForFunction(() => !(document.querySelector("#start-btn") as HTMLButtonElement).disabled, undefined, { timeout: 30000 });

    await page.locator("#auth-only").check();
    await page.locator("#workflow-ids").fill("profiles/<profile-id>.workflows.json");
    await page.locator("#start-btn").click();
    expect(await page.locator("#status-line").textContent()).toContain("Enter the username and password");

    await page.locator("#auth-only").uncheck();
    await page.locator("#auth-username").fill("demo-a");
    await page.locator("#auth-password").fill("demo-a-synthetic-password");
    await page.locator("#start-btn").click();
    expect(await page.locator("#status-line").textContent()).toContain("not a file path");
    // Nothing was cleared, so correcting one field is enough.
    expect(await page.locator("#auth-password").inputValue()).toBe("demo-a-synthetic-password");
    expect(runPosts).toBe(0);
    expect([...server.hits.values()].reduce((a, b) => a + b, 0)).toBe(1); // readiness probe only
  }, 60_000);
});
