import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterEach, expect, it } from "vitest";
import { startServer } from "../../src/server/app.js";

const servers: Server[] = [];
let browser: Browser | undefined;
afterEach(async () => {
  await browser?.close(); browser = undefined;
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

it.each([false, true])("shows real check evidence and preserves Stop during HTTP body reading (cancel=%s)", async cancel => {
  let reached!: () => void;
  const started = new Promise<void>(r => { reached = r; });
  let hits = 0;
  const target = createServer((req, res) => {
    if (req.url === "/api/check") {
      hits++; res.writeHead(500, { "content-type": "application/json" }); res.flushHeaders(); reached();
      if (!cancel) res.end('{"password":"synthetic-private-value"}');
      return;
    }
    res.setHeader("content-type", "text/html"); res.end("<h1>Synthetic check target</h1>");
  });
  servers.push(target); await new Promise<void>(r => target.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + (target.address() as AddressInfo).port;
  const root = mkdtempSync(join(tmpdir(), "checks-ui-")), profiles = join(root, "profiles"), runs = join(root, "runs");
  mkdirSync(profiles);
  const profile = JSON.parse(readFileSync("profiles/checks-demo.json", "utf8"));
  profile.id = "checks"; profile.name = "Synthetic checks";
  profile.target = { url: origin, environmentKind: "owned-sandbox" };
  profile.navigation.allowedOrigins = [origin]; profile.resources.allowedApiOrigins = [origin];
  profile.limits.maxApiRequests = 3;
  writeFileSync(join(profiles, "checks.json"), JSON.stringify(profile));
  writeFileSync(join(profiles, "checks.checks.json"), JSON.stringify({ schemaVersion: 1, profileId: "checks", apiChecks: [{ id: "status", method: "GET", pathname: "/api/check", description: "Expected healthy status", assertions: { expectedStatus: 200 } }], securityChecks: [{ id: "headers", kind: "security-headers", pathname: "/", description: "Header context" }] }));
  const ui = await startServer({ port: 0, profilesDir: profiles, runsDir: runs }); servers.push(ui.server);
  const base = "http://127.0.0.1:" + ui.port;
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  await page.goto(base);
  const response = page.waitForResponse(r => r.url() === base + "/api/runs" && r.request().method() === "POST");
  await page.locator("#start-btn").click();
  const runId = (await (await response).json()).runId;
  await started;
  if (cancel) {
    const active = await (await fetch(base + "/api/runs/" + runId + "/status")).json();
    expect(active.active).toBe(true);
    expect(active.lastEvent.phase).not.toBe("completed");
    await page.locator("#stop-btn").click();
  }
  await page.waitForFunction(() => !(document.querySelector("#start-btn") as HTMLButtonElement).disabled, null, { timeout: 30000 });
  await page.getByRole("heading", { name: "API and security checks", exact: true }).waitFor();
  const summary = JSON.parse(readFileSync(join(runs, runId, "run-summary.json"), "utf8"));
  const usage = JSON.parse(readFileSync(join(runs, runId, "check-usage.json"), "utf8"));
  expect(summary.status).toBe(cancel ? "cancelled" : "completed");
  expect(usage.requests).toBe(cancel ? 1 : 3);
  expect(hits).toBe(cancel ? 1 : 2);
  expect(await page.locator("#stop-btn").isHidden()).toBe(true);
  if (!cancel) {
    // A reproduced API mismatch is labelled as an assertion mismatch, not a confirmed defect.
    await page.getByRole("heading", { name: "[API] status — reproduced assertion mismatch — review before calling it a defect", exact: true }).waitFor();
    const link = page.locator('a[href$="confirmation.json"]').first();
    const evidence = await fetch(new URL((await link.getAttribute("href"))!, base));
    expect(evidence.status).toBe(200); expect(await evidence.text()).not.toContain("synthetic-private-value");
  }
}, 45000);
