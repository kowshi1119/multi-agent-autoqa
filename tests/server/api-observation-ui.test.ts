import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { startServer } from "../../src/server/app.js";
import { saveSuite } from "../../src/suites/suite-manifest.js";
import { credentials, suiteEnvironment } from "../helpers/suite-env.js";

/**
 * Phase 13 flow in the real control panel: observed → drafted → approved →
 * comparison declared → suite executed → verified / failed / not assessed,
 * with baseline comparison. Timing comes from page state, never sleeps.
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

describe("API observation, check drafts and UI–API comparison in the control panel", () => {
  it("turns an observation into an approved check and a comparison, then shows match, mismatch, correction and changed data", async () => {
    // Run A: the statements page draws its table from the application's own GET /api/statement-list, which is observed.
    server = await startAuthFixtureServer({ statementListApi: "client" });
    const env = suiteEnvironment(server.origin, { apiChecks: [], securityChecks: [] });
    env.writeProfile({ apiChecks: { enabled: false, allowedMutatingEndpoints: [], responseSizeCapBytes: 65536, useRunSession: false } });
    saveSuite(env.store, "demo", { id: "wf", name: "Workflow", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }], limits: {} });
    const ui = await startServer({ port: 0, profilesDir: env.profilesDir, runsDir: env.runsDir });
    closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${ui.port}`);
    await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
    await page.locator("#profile-select").selectOption("demo");
    await page.waitForFunction(() => /^Target: /.test(document.querySelector("#target-line")?.textContent ?? ""), undefined, { timeout: 30000 });
    await page.locator("#suite-select").selectOption("wf");
    await runFromUi(page); // run A: records the observation
    // Later runs use server-rendered rows, so the separately sent check is the only reader of the API.
    const port = server.port;
    await server.close();
    server = await startAuthFixtureServer({ port });

    // Observed → Drafted → Approved.
    await page.waitForFunction(() => (document.querySelector("#obs-run-select") as HTMLSelectElement).options.length > 1, undefined, { timeout: 30000 });
    await page.locator("#obs-run-select").selectOption({ index: 1 });
    await page.locator("#obs-load-btn").click();
    const endpoint = page.locator(".obs-endpoint").filter({ hasText: "GET /api/statement-list" });
    await endpoint.waitFor();
    expect(await endpoint.textContent()).toContain("[Observed]");
    await endpoint.locator(".obs-pick").check();
    await endpoint.locator("input[data-query='page']").fill("1");
    await endpoint.locator("input[data-query='pageSize']").fill("5");
    await endpoint.locator("input[data-assertion='status']").check();
    await endpoint.locator("input[data-assertion='shape:items']").check();
    await page.locator("#obs-review-btn").click();
    await page.locator(".obs-draft[data-executable='true']").waitFor();
    expect(await page.locator(".obs-draft").textContent()).toContain("Official contract: none");
    await page.locator("#obs-enable-api").check();
    await page.locator("#obs-approve-btn").click();
    await page.waitForFunction(() => /^\[Approved\] OBS-api-statement-list\. API checks are enabled/.test(document.querySelector("#obs-status")?.textContent ?? ""), undefined, { timeout: 30000 });

    // A comparison that is unsound is refused with the reason; a sound one is saved.
    await page.locator("#cmp-details summary").click();
    await page.locator("#cmp-id").fill("UI-API-STATUS");
    await page.locator("#cmp-description").fill("Statement status matches the API");
    await page.locator("#cmp-workflow").selectOption("OPEN-STATEMENTS");
    await page.locator("#cmp-table").fill("Statement results");
    await page.locator("#cmp-key-column").fill("Merchant");
    await page.locator("#cmp-value-column").fill("Amount");
    await page.locator("#cmp-check").selectOption("OBS-api-statement-list");
    await page.locator("#cmp-items-path").fill("items");
    await page.locator("#cmp-key-field").fill("merchant");
    await page.locator("#cmp-value-field").fill("amount");
    await page.locator("#cmp-page-param").fill("page");
    await page.locator("#cmp-page-size-param").fill("pageSize");
    await page.locator("#cmp-page-size").fill("5");
    await page.locator("#cmp-save-btn").click();
    await page.waitForFunction(() => /monetary or date\/time/.test(document.querySelector("#cmp-status")?.textContent ?? ""));
    await page.locator("#cmp-value-column").fill("Status");
    await page.locator("#cmp-value-field").fill("status");
    await page.locator("#cmp-save-btn").click();
    await page.waitForFunction(() => /^\[Approved\] comparison UI-API-STATUS/.test(document.querySelector("#cmp-status")?.textContent ?? ""), undefined, { timeout: 30000 });

    // Suite with the workflow and the comparison.
    await page.waitForFunction(() => !(document.querySelector("#suite-new-btn") as HTMLButtonElement).disabled);
    await page.locator("#suite-new-btn").click();
    await page.locator("#suite-id").fill("ui-api");
    await page.locator("#suite-name").fill("UI-API");
    const row = (text: string) => page.locator(".suite-item-row").filter({ hasText: text });
    await row("workflow OPEN-STATEMENTS — Open Statements").locator("input[id^=suite-include]").check();
    await row("consistency-check UI-API-STATUS").locator("input[id^=suite-include]").check();
    await page.locator("#suite-save-btn").click();
    await page.waitForFunction(() => /^Saved UI-API as revision 1/.test(document.querySelector("#suite-status")?.textContent ?? ""));

    // Healthy → baseline; mismatch; corrected; changed data.
    await runFromUi(page);
    expect(await page.locator("#suite-result .suite-decision").getAttribute("data-decision")).toBe("PASS");
    expect(await page.locator("ul[data-list='ui-api-comparisons']").textContent()).toContain("consistency-check:UI-API-STATUS#consistency:status: pass");
    await page.locator("#approve-baseline-btn").click();
    await page.waitForFunction(() => /^Approved: run /.test(document.querySelector("#baseline-reason")?.textContent ?? ""));

    server.setBugs({ apiStatusMismatch: true });
    await runFromUi(page);
    expect(await page.locator("#suite-result .suite-decision").getAttribute("data-decision")).toBe("FAIL");
    expect(await page.locator("ul[data-list='ui-api-comparisons']").textContent()).toContain("Reproduced on a second observation of both sides");

    server.setBugs({});
    await runFromUi(page);
    expect(await page.locator("#suite-result .suite-decision").getAttribute("data-decision")).toBe("PASS");

    server.setBugs({ apiStatusFlapping: true });
    await runFromUi(page);
    expect(await page.locator("#suite-result .suite-decision").getAttribute("data-decision")).toBe("INCOMPLETE");
    expect(await page.locator("ul[data-list='ui-api-comparisons']").textContent()).toContain("(data-changed)");
  }, 400_000);
});
