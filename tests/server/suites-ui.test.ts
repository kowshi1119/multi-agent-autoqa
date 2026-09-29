import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { startServer } from "../../src/server/app.js";
import { credentials, suiteEnvironment } from "../helpers/suite-env.js";

/**
 * The regression flow in the real control panel: choose application →
 * create a suite → run → approve the baseline → seeded regression → review
 * changes → fix → review again. Timing comes from page state, never sleeps.
 */
let server: AuthFixtureServer | undefined;
let browser: Browser | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await browser?.close(); browser = undefined;
  await server?.close(); server = undefined;
  for (const close of closers.splice(0)) await close();
});

async function runFromUi(page: Page): Promise<void> {
  await page.waitForFunction(() => !(document.querySelector("#start-btn") as HTMLButtonElement).disabled, undefined, { timeout: 30000 });
  await page.locator("#auth-username").fill(credentials.username);
  await page.locator("#auth-password").fill(credentials.password);
  const previous = await page.evaluate(() => document.querySelector("#suite-result")?.getAttribute("data-run") ?? "");
  await page.locator("#start-btn").click();
  // A new run hides the previous results; wait for this run's own result panel.
  await page.waitForFunction((prev) => {
    const panel = document.querySelector("#suite-result");
    return /^(Completed|Stopped|Failed)/.test(document.querySelector("#status-line")?.textContent ?? "") && panel !== null && panel.getAttribute("data-run") !== prev && panel.querySelector(".suite-decision") !== null;
  }, previous, { timeout: 90000 });
  await page.locator("#suite-result .suite-decision").waitFor({ timeout: 15000 });
}

describe("regression suites in the control panel", () => {
  it("creates a suite, runs it, approves a baseline, detects a seeded regression, and recognises the fix", async () => {
    server = await startAuthFixtureServer();
    const env = suiteEnvironment(server.origin);
    const ui = await startServer({ port: 0, profilesDir: env.profilesDir, runsDir: env.runsDir });
    closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${ui.port}`);
    await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
    expect(await page.locator("#suites-section").isHidden()).toBe(true);
    await page.locator("#profile-select").selectOption("demo");
    await page.locator("#suites-section").waitFor({ state: "visible" });
    await page.waitForFunction(() => !(document.querySelector("#suite-new-btn") as HTMLButtonElement).disabled && document.querySelectorAll("#suite-select option").length >= 1);

    // Create the suite: two required items and one optional check.
    await page.waitForFunction(() => /^Target: /.test(document.querySelector("#target-line")?.textContent ?? ""), undefined, { timeout: 30000 });
    await page.locator("#suite-new-btn").click();
    await page.locator("#suite-id").fill("smoke");
    await page.locator("#suite-name").fill("Smoke");
    const row = (text: string) => page.locator(".suite-item-row").filter({ hasText: text });
    await row("workflow OPEN-STATEMENTS").locator("input[id^=suite-include]").check();
    await row("api-check ME").locator("input[id^=suite-include]").check();
    await row("security-check HEADERS").locator("input[id^=suite-include]").check();
    await row("security-check HEADERS").locator("input[id^=suite-required]").uncheck();
    expect(await row("api-check TRANSFER").textContent()).toContain("never sent");
    await page.locator("#suite-save-btn").click();
    await page.waitForFunction(() => /^Saved Smoke as revision 1/.test(document.querySelector("#suite-status")?.textContent ?? ""));
    expect(await page.locator("#suite-select").inputValue()).toBe("smoke");
    expect(await page.locator("#suite-scope").textContent()).toContain("Required: OPEN-STATEMENTS, ME · Optional: HEADERS");
    expect(await page.locator("#suite-scope").textContent()).toContain("Baseline: none approved yet");
    await page.waitForFunction(() => /Suite Smoke rev 1 \(2 required, 1 optional\)/.test(document.querySelector("#target-line")?.textContent ?? ""));
    expect(await page.locator("#auth-only").isDisabled()).toBe(true);

    // Healthy run → PASS, no comparison yet → approve.
    await runFromUi(page);
    expect(await page.locator("#suite-result .suite-decision").getAttribute("data-decision")).toBe("PASS");
    expect(await page.locator("#suite-result").textContent()).toContain("No approved baseline");
    await page.locator("#approve-baseline-btn").click();
    await page.waitForFunction(() => /^Approved: run /.test(document.querySelector("#baseline-reason")?.textContent ?? ""));
    await page.waitForFunction(() => /Baseline: run RUN-/.test(document.querySelector("#suite-scope")?.textContent ?? ""));

    // Seeded workflow regression.
    server.setBugs({ statementsHeadingChanged: true });
    await runFromUi(page);
    expect(await page.locator("#suite-result .suite-decision").getAttribute("data-decision")).toBe("FAIL");
    const newly = page.locator("#suite-result ul[data-category-list='newly-failing']");
    expect(await newly.textContent()).toContain("workflow:OPEN-STATEMENTS#visible [required]");
    expect(await newly.textContent()).toContain("expected heading Statements · observed not visible · baseline observed visible");
    expect(await newly.locator("a").first().getAttribute("href")).toMatch(/workflows\/OPEN-STATEMENTS\.json$/);
    expect(await page.locator("#suite-result ul[data-category-list='still-failing']").textContent()).toContain("same finding as in the baseline");
    expect(await page.locator("#approve-baseline-btn").isDisabled()).toBe(true);
    expect(await page.locator("#baseline-reason").textContent()).toContain("A required item failed");
    expect(await page.locator("#suite-result").textContent()).toMatch(/Browser actions: \d+ · HTTP check requests: \d+ · Model decisions: \d+ · External model requests: 0/);

    // Corrected.
    server.setBugs({});
    await runFromUi(page);
    expect(await page.locator("#suite-result .suite-decision").getAttribute("data-decision")).toBe("PASS");
    expect(await page.locator("#suite-result h4[data-category='newly-failing']").textContent()).toBe("Newly failing (0)");
    // Eligible, but replacing the baseline needs an explicit confirmation.
    await page.locator("#approve-baseline-btn").click();
    expect(await page.locator("#baseline-reason").textContent()).toContain("Tick the confirmation");
  }, 300_000);
});
