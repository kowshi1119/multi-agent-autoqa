import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { startServer } from "../../src/server/app.js";
import { credentials, suiteEnvironment } from "../helpers/suite-env.js";

/**
 * Phase 12 flow in the real control panel. Timing comes from page state
 * (a new run's own result panel), never from sleeps.
 */
let server: AuthFixtureServer | undefined;
let browser: Browser | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await browser?.close(); browser = undefined;
  await server?.close(); server = undefined;
  for (const c of closers.splice(0)) await c();
});

async function runFromUi(page: Page): Promise<void> {
  await page.waitForFunction(() => !(document.querySelector("#start-btn") as HTMLButtonElement).disabled, undefined, { timeout: 30000 });
  const previous = await page.evaluate(() => document.querySelector("#coverage-report")?.getAttribute("data-run") ?? "");
  await page.locator("#auth-username").fill(credentials.username);
  await page.locator("#auth-password").fill(credentials.password);
  await page.locator("#start-btn").click();
  await page.waitForFunction((prev) => {
    const panel = document.querySelector("#coverage-report");
    return /^(Completed|Stopped|Failed)/.test(document.querySelector("#status-line")?.textContent ?? "") && panel !== null && panel.getAttribute("data-run") !== prev && panel.querySelector("#coverage-summary") !== null && document.querySelector("#suite-result .suite-decision") !== null;
  }, previous, { timeout: 90000 });
}

describe("requirements, contracts and coverage in the control panel", () => {
  it("imports a contract, approves a draft and a requirement, runs a suite, and shows coverage, a regression and its fix", async () => {
    server = await startAuthFixtureServer({ securityHeaders: "partial" });
    const env = suiteEnvironment(server.origin);
    const ui = await startServer({ port: 0, profilesDir: env.profilesDir, runsDir: env.runsDir });
    closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${ui.port}`);
    await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
    await page.locator("#profile-select").selectOption("demo");
    await page.waitForFunction(() => /^Target: /.test(document.querySelector("#target-line")?.textContent ?? ""), undefined, { timeout: 30000 });
    await page.locator("#requirements-section").waitFor({ state: "visible" });

    // Import a local contract and approve one scoped GET draft.
    await page.locator("#contract-file").setInputFiles({ name: "accounts.openapi.json", mimeType: "application/json", buffer: readFileSync("fixture/contracts/accounts.openapi.json") });
    const op = page.locator(".contract-op[data-operation='GET /api/accounts/{accountId}']");
    await op.waitFor();
    expect(await page.locator(".contract-op[data-operation='POST /api/transfer']").textContent()).toContain("not approvable");
    await op.locator("input[type=checkbox]").check();
    await op.locator("input[data-param='accountId']").fill("acc-1");
    await page.locator("#contract-preview-btn").click();
    await page.locator(".contract-draft[data-executable='true']").waitFor();
    expect(await page.locator(".contract-draft").textContent()).toContain("GET /api/accounts/acc-1 on this application's origin only");
    await page.locator("#contract-approve-btn").click();
    await page.waitForFunction(() => /^Approved CONTRACT-GETACCOUNT/.test(document.querySelector("#contract-status")?.textContent ?? ""), undefined, { timeout: 30000 });

    // Define, map and approve a requirement.
    await page.waitForFunction(() => document.querySelectorAll("#req-list").length === 1);
    await page.locator("#req-new-btn").click();
    await page.locator("#req-id").fill("REQ-ACCOUNT");
    await page.locator("#req-title").fill("Account balances are integer minor units");
    await page.locator("#req-importance").selectOption("critical");
    const criterion = page.locator("#req-criteria .req-criterion").first();
    await criterion.locator(".crit-desc").fill("The balance amount is an integer number of minor units");
    await criterion.locator(".crit-links").selectOption(["api-check|CONTRACT-GETACCOUNT|contract:$.balance.minorUnits:type", "api-check|CONTRACT-GETACCOUNT|contract:$.balance:required"]);
    await page.locator("#req-save-btn").click();
    await page.waitForFunction(() => /as a draft/.test(document.querySelector("#req-status")?.textContent ?? ""));
    await page.locator("[data-requirement='REQ-ACCOUNT'] .req-approve-btn").click();
    await page.waitForFunction(() => /^Approved REQ-ACCOUNT revision 1/.test(document.querySelector("#req-status")?.textContent ?? ""));
    expect(await page.locator("[data-requirement='REQ-ACCOUNT']").textContent()).toContain("approved");

    // Suite with the approved contract check and a workflow.
    await page.waitForFunction(() => !(document.querySelector("#suite-new-btn") as HTMLButtonElement).disabled);
    await page.locator("#suite-new-btn").click();
    await page.locator("#suite-id").fill("accounts");
    await page.locator("#suite-name").fill("Accounts");
    const row = (text: string) => page.locator(".suite-item-row").filter({ hasText: text });
    await row("workflow OPEN-STATEMENTS").locator("input[id^=suite-include]").check();
    await row("api-check CONTRACT-GETACCOUNT").locator("input[id^=suite-include]").check();
    await page.locator("#suite-save-btn").click();
    await page.waitForFunction(() => /^Saved Accounts as revision 1/.test(document.querySelector("#suite-status")?.textContent ?? ""));

    // Healthy run → approve baseline.
    await runFromUi(page);
    expect(await page.locator("#suite-result .suite-decision").getAttribute("data-decision")).toBe("PASS");
    expect(await page.locator("#coverage-summary").textContent()).toContain("Requirements passed: 1 of 1 approved (100%)");
    expect(await page.locator("#coverage-table tr[data-requirement='REQ-ACCOUNT']").getAttribute("data-status")).toBe("passed");
    expect(await page.locator("#coverage-report").textContent()).toContain("not coverage of the entire application");
    await page.locator("#approve-baseline-btn").click();
    await page.waitForFunction(() => /^Approved: run /.test(document.querySelector("#baseline-reason")?.textContent ?? ""));

    // Seeded contract regression.
    server.setBugs({ contractWrongType: true });
    await runFromUi(page);
    expect(await page.locator("#suite-result .suite-decision").getAttribute("data-decision")).toBe("FAIL");
    expect(await page.locator("#coverage-table tr[data-requirement='REQ-ACCOUNT']").getAttribute("data-status")).toBe("failed");
    expect(await page.locator("ul[data-list='newly-failing-criteria']").textContent()).toContain("REQ-ACCOUNT#C1: passed → failed");
    expect(await page.locator("ul[data-list='contract-mismatches']").textContent()).toContain("contract:$.balance.minorUnits:type: expected integer, observed got string");
    expect(await page.locator("#coverage-report a").first().getAttribute("href")).toMatch(/coverage-report\.json$/);

    // Corrected.
    server.setBugs({});
    await runFromUi(page);
    expect(await page.locator("#suite-result .suite-decision").getAttribute("data-decision")).toBe("PASS");
    expect(await page.locator("h4[data-section='newly-failing-criteria']").textContent()).toBe("Newly failing criteria (0)");
    expect(await page.locator("#coverage-table tr[data-requirement='REQ-ACCOUNT']").getAttribute("data-status")).toBe("passed");
  }, 300_000);
});
