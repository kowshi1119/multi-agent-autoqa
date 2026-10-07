import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { INERT_PAYLOADS } from "../../fixture/canaries.js";
import { startServer } from "../../src/server/app.js";
import { saveSuite } from "../../src/suites/suite-manifest.js";
import { runSuite, suiteEnvironment } from "../helpers/suite-env.js";

/**
 * Application text is untrusted. A diagnostic run (which keeps page text
 * locally) of a page carrying markup-like payloads, plus a finding whose
 * every text field is a payload, is opened in the real control panel: the
 * payloads must appear as text, nothing may execute, and no remote
 * resource may load. The export preview of the same run stays inert too.
 */
let server: AuthFixtureServer | undefined;
let browser: Browser | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await browser?.close(); browser = undefined;
  await server?.close(); server = undefined;
  for (const c of closers.splice(0)) await c();
});

describe("untrusted application text in the control panel", () => {
  it("renders markup-like payloads as inert text in results and the export preview", async () => {
    server = await startAuthFixtureServer({ canaries: "inert" });
    const env = suiteEnvironment(server.origin);
    env.writeProfile({ evidencePolicy: "diagnostic" });
    saveSuite(env.store, "demo", { id: "p", name: "Payloads", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }], limits: {} });
    const run = await runSuite(env, "p");
    const reportPath = join(run.dir, "report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as { findings: unknown[]; stopReason?: string };
    const payload = INERT_PAYLOADS.join(" | ");
    report.findings.push({
      id: "FINDING-099", title: payload, displayTitle: payload, status: "validated", category: "console", pageId: "PAGE-001", url: `${server.origin}/home`, pathname: payload,
      expected: payload, actual: payload, oracle: { oracleId: "console-error", suspicious: true, expected: payload, actual: payload }, steps: [], reproduction: { attempts: 2, successes: 2 },
      occurrenceCount: 1, evidence: ["oracle.json"], evidenceLevel: "L2", reportDisposition: "report",
    });
    writeFileSync(reportPath, JSON.stringify(report));

    const ui = await startServer({ port: 0, profilesDir: env.profilesDir, runsDir: env.runsDir });
    closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const remoteRequests: string[] = [];
    page.on("request", (r) => { if (!r.url().startsWith(`http://127.0.0.1:${ui.port}`)) remoteRequests.push(r.url()); });
    await page.goto(`http://127.0.0.1:${ui.port}`);
    const scriptsBefore = await page.locator("script").count();
    await page.locator(".run-row", { hasText: run.runId }).click();
    await page.locator("#results h3", { hasText: "FINDING-099" }).first().waitFor({ timeout: 30_000 });
    await page.locator("#export-preview-btn").click();
    await page.locator(`#export-preview p[data-export-run='${run.runId}']`).waitFor({ timeout: 30_000 });

    expect(await page.evaluate(() => (window as unknown as { __autoqaXss?: number }).__autoqaXss)).toBeUndefined();
    // The panel's own evidence previews are same-origin artifact URLs it builds itself; no other image may appear.
    const imageSources = await page.locator("#results img, #export-preview img").evaluateAll((els) => els.map((e) => e.getAttribute("src") ?? ""));
    expect(imageSources.filter((src) => !src.startsWith(`/api/artifacts/${run.runId}/`))).toEqual([]);
    expect(await page.locator("script").count()).toBe(scriptsBefore);
    expect(await page.locator("#results a[href^='javascript:']").count()).toBe(0);
    expect(await page.locator("#results h3", { hasText: "FINDING-099" }).first().textContent()).toContain('<img src=x onerror="window.__autoqaXss=1">');
    expect(await page.locator("#export-preview").textContent()).toContain("diagnostic");
    expect(remoteRequests).toEqual([]);
  }, 240_000);
});
