import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { startServer } from "../dist/src/server/app.js";

// Synthetic fixture only. Use after build + copy-public-assets; no login,
// model credentials, or private profiles are read by the UI server.
const root = resolve("test-results/fixture-ui-acceptance");
mkdirSync(root + "/profiles", { recursive: true });
writeFileSync(root + "/profiles/fixture.json", readFileSync("profiles/fixture.json"));
const ui = await startServer({ port: 0, profilesDir: root + "/profiles", runsDir: resolve("runs") });
const base = "http://127.0.0.1:" + ui.port;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  await page.goto(base);
  await page.selectOption("#profile-select", "fixture");
  await page.waitForFunction(() => !document.querySelector("#start-btn").disabled);
  await page.screenshot({ path: root + "/setup-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: root + "/setup-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1365, height: 900 });
  const start = async () => {
    const response = page.waitForResponse(r => r.url() === base + "/api/runs" && r.request().method() === "POST");
    await page.locator("#start-btn").click();
    const result = await response;
    assert.equal(result.status(), 200);
    return (await result.json()).runId;
  };
  const finish = async id => {
    await page.waitForFunction(() => !document.querySelector("#start-btn").disabled, null, { timeout: 360000 });
    const status = await (await fetch(base + "/api/runs/" + id + "/status")).json();
    assert.equal(status.active, false);
    const reportResponse = await fetch(base + "/api/artifacts/" + id + "/report.json");
    assert.equal(reportResponse.status, 200);
    const summary = JSON.parse(readFileSync(resolve("runs", id, "run-summary.json"), "utf8"));
    assert.equal(summary.usage.explorer.requests, 0);
    assert.equal(summary.usage.critic.requests, 0);
    return summary;
  };
  const completedId = await start();
  await page.waitForFunction(() => Number(document.querySelector("#c-actions").textContent) > 0, null, { timeout: 60000 });
  const completed = await finish(completedId);
  assert.equal(completed.status, "completed");
  await page.locator("#results-section").waitFor({ state: "visible" });
  const evidence = page.locator('#results a[href*="/api/artifacts/"]').first();
  await evidence.waitFor();
  const evidenceUrl = await evidence.getAttribute("href");
  assert.equal((await fetch(new URL(evidenceUrl, base))).status, 200);
  await page.screenshot({ path: root + "/results-desktop.png", fullPage: true });
  const cancelledId = await start();
  let observedProgress;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const status = await (await fetch(base + "/api/runs/" + cancelledId + "/status")).json();
    if (status.active && status.lastEvent?.actionsPerformed > 0) { observedProgress = status.lastEvent; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(observedProgress?.actionsPerformed > 0, "Wait for actual current-run action progress before Stop");
  await page.locator("#stop-btn").click();
  const cancelled = await finish(cancelledId);
  assert.equal(cancelled.status, "cancelled");
  assert(cancelled.actionsPerformed >= observedProgress.actionsPerformed);
  assert.equal(await page.locator("#stop-btn").isVisible(), false);
  const result = { generatedAt: new Date().toISOString(), fixtureOnly: true, completed, cancelled, evidenceLinkReturned200: true, startUsableAfterStop: true, mobileOverflow: false };
  writeFileSync(root + "/acceptance.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  ui.server.closeAllConnections();
  await new Promise(resolve => ui.server.close(resolve));
}
