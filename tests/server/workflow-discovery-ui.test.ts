import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { startServer } from "../../src/server/app.js";

/**
 * The 1d panel end to end on the synthetic sign-in fixture: stateful drafts
 * show their kind, steps, assertions, reset and observation; a kind the
 * profile does not allow is listed as needing configuration; a confirmed
 * draft is saved, the target is re-prepared (the saved workflows change the
 * configuration fingerprint), and the saved workflow runs to a QA summary.
 */
const closers: Array<() => Promise<void>> = [];
let browser: Browser | undefined;
let fixture: AuthFixtureServer | undefined;
afterEach(async () => {
  await browser?.close(); browser = undefined;
  await fixture?.close(); fixture = undefined;
  for (const close of closers.splice(0)) await close();
});

describe("workflow discovery panel (1d)", () => {
  it("shows stateful drafts with assertions and reset, lists what needs configuration, saves only the confirmed draft, and runs it", async () => {
    fixture = await startAuthFixtureServer();
    const origin = fixture.origin;
    const root = mkdtempSync(join(tmpdir(), "autoqa-wd-ui-"));
    const profiles = join(root, "profiles"); mkdirSync(profiles);
    writeFileSync(join(profiles, "wf.json"), JSON.stringify({
      schemaVersion: 1, id: "wf", name: "Synthetic statements", target: { url: `${origin}/home`, environmentKind: "owned-sandbox" },
      navigation: { allowedOrigins: [origin], allowedPathPrefixes: ["/"] },
      resources: { allowedApiOrigins: [origin], allowedFormSubmitEndpoints: [{ method: "get", pathname: "/statements" }] },
      // "filter" deliberately not allowed: its controls must be reported, not used.
      workflows: { allowedWorkflowKinds: ["navigate", "search", "paginate"], executionMode: "declared" },
      auth: { mode: "form-login", checksVerified: true, loginUrl: `${origin}/login`, usernameField: { label: "Username" }, passwordField: { label: "Password" }, submitControl: { role: "button", name: "Sign in" }, successUrlPattern: `^${origin.replace(/[.]/g, "\\.")}/home(?:[?#].*)?$`, authenticatedSignal: { role: "heading", name: "Demo Home" }, allowedRequests: [{ origin, method: "POST", pathname: "/session" }] },
      provider: { explorer: { provider: "mock" }, critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 30000 },
      limits: { maxActions: 60, maxModelCalls: 60, maxPages: 10, maxFindings: 5, maxDurationMs: 120000, maxCriticCalls: 5 },
    }));
    const ui = await startServer({ port: 0, profilesDir: profiles, runsDir: join(root, "runs") });
    closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${ui.port}`);
    await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
    await page.locator("#profile-select").selectOption("wf");
    await page.waitForFunction(() => !(document.querySelector("#wd-discover-btn") as HTMLButtonElement).disabled, undefined, { timeout: 20000 });

    await page.locator("#wd-username").fill("demo-a");
    await page.locator("#wd-password").fill("demo-a-synthetic-password");
    await page.locator("#wd-discover-btn").click();
    await page.locator("#wd-result").waitFor({ state: "visible", timeout: 90000 });
    expect(await page.locator("#wd-password").inputValue()).toBe("");

    const search = page.locator("#wd-candidates .card").filter({ hasText: "Kind: search" }).first();
    const searchText = (await search.textContent()) ?? "";
    expect(searchText).toContain("Steps: 1. Type");
    expect(searchText).toContain("Press Enter");
    expect(searchText).toMatch(/query q = "/);
    expect(searchText).toContain("results differ from the starting page");
    expect(searchText).toContain("Reset: Return to /statements");
    expect(searchText).toContain("Observed during discovery");
    expect(await page.locator("#wd-needs-config").textContent()).toContain("filter");
    // Filter controls were read, never used (the search form's own empty "All" default is not a filter).
    expect(fixture.requestLog.some((r) => /status=(paid|pending)/.test(r))).toBe(false);

    const box = search.locator("input[type=checkbox]");
    await box.check();
    const searchId = ((await search.locator("label").textContent()) ?? "").match(/Confirm (\S+)/)?.[1];
    expect(searchId).toMatch(/^SEARCH-/);
    await page.locator("#wd-save-btn").click();
    await page.waitForFunction(() => /^Saved /.test(document.querySelector("#wd-status")?.textContent ?? ""));
    const saved = JSON.parse(readFileSync(join(profiles, "wf.workflows.json"), "utf-8")) as { workflows: Array<{ id: string }> };
    expect(saved.workflows.map((w) => w.id)).toEqual([searchId]);

    // Saving changed the configuration; Start is available only once the target is prepared again.
    await page.waitForFunction(() => !(document.querySelector("#start-btn") as HTMLButtonElement).disabled, undefined, { timeout: 20000 });
    expect(await page.locator("#target-line").textContent()).toContain("Synthetic statements");
    await page.locator("#auth-username").fill("demo-a");
    await page.locator("#auth-password").fill("demo-a-synthetic-password");
    await page.locator("#start-btn").click();
    await page.waitForFunction(() => /^(Completed|Stopped|Failed)/.test(document.querySelector("#status-line")?.textContent ?? ""), undefined, { timeout: 90000 });
    const verdict = page.locator("#qa-summary .qa-verdict");
    await verdict.waitFor({ timeout: 10000 });
    expect(await verdict.getAttribute("data-verdict")).toBe("passed-within-scope");
    expect(await page.locator("#qa-summary").textContent()).toContain("completed 1");
    expect(await page.locator("#qa-summary table.qa-assertions").count()).toBe(1);
  }, 240_000);
});
