import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { startServer } from "../dist/src/server/app.js";

// Only the shipped synthetic checks profile is loaded. Real credentials
// and private profiles are not inputs to this demonstration.
const root = resolve("test-results/checks-ui-acceptance");
mkdirSync(root + "/profiles", { recursive: true });
for (const file of ["checks-demo.json", "checks-demo.checks.json"]) {
  writeFileSync(root + "/profiles/" + file, readFileSync("profiles/" + file));
}
const ui = await startServer({ profilesDir: root + "/profiles", runsDir: resolve("runs") });
const base = "http://127.0.0.1:" + ui.port;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  await page.goto(base);
  await page.selectOption("#profile-select", "checks-demo");
  const starting = page.waitForResponse(r => r.url() === base + "/api/runs" && r.request().method() === "POST");
  await page.locator("#start-btn").click();
  const start = await starting; assert.equal(start.status(), 200);
  const runId = (await start.json()).runId;
  await page.waitForFunction(() => !document.querySelector("#start-btn").disabled, null, { timeout: 150000 });
  await page.getByRole("heading", { name: "API and security checks", exact: true }).waitFor();
  const data = await (await fetch(base + "/api/runs/" + runId + "/checks")).json();
  const classification = Object.fromEntries(data.entries.map(e => [e.checkId, e.classification]));
  assert.deepEqual(classification, {
    "API-USERS-OK": "passed", "API-USERS-MISSING": "confirmed", "API-DELETE-BLOCKED": "unsupported",
    "SEC-COOKIE": "needs_review", "SEC-HEADERS": "needs_review", "SEC-LEAK": "passed", "SEC-SESSION-BOUNDARY": "needs_review"
  });
  assert.equal(data.usage.requests, 10);
  for (const entry of data.entries) for (const ref of entry.evidenceRefs) {
    const response = await fetch(base + "/api/artifacts/" + runId + "/" + ref);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert(!/demo-session-[ab]|private note for/.test(text));
    JSON.parse(text);
  }
  await page.locator("#results-section").screenshot({ path: root + "/results-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator("#results-section").screenshot({ path: root + "/results-mobile.png" });
  const summary = JSON.parse(readFileSync(resolve("runs", runId, "run-summary.json"), "utf8"));
  assert.equal(summary.status, "completed");
  assert.equal(summary.usage.explorer.requests + summary.usage.critic.requests, 0);
  const result = { runId, classification, usage: data.usage, actions: summary.actionsPerformed, mockDecisions: summary.modelCalls, externalModelRequests: 0, evidenceAccessibleAndParseable: true, mobileOverflow: false };
  writeFileSync(root + "/acceptance.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  ui.server.closeAllConnections();
  await new Promise(resolve => ui.server.close(resolve));
}
