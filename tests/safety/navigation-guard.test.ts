import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import {
  installAsyncRedirectGuard,
  installPopupGuard,
  installRouteGuard,
} from "../../src/safety/navigation-guard.js";
import type { SafetyEvent } from "../../src/types.js";

const PORT = 4199;
const ORIGIN = `http://localhost:${PORT}`;
const ALLOWED_ORIGINS = [ORIGIN];

const PAGE_HTML = `<!doctype html><html><body>
  <a id="offsite" href="https://example.com/">Offsite link</a>
  <a id="onsite" href="/other">Onsite link</a>
  <form id="offform" action="https://example.com/submit" method="get">
    <button type="submit" id="offform-submit">Submit off-origin</button>
  </form>
  <button id="popupbtn" onclick="window.open('https://example.com/', '_blank')">Open popup</button>
</body></html>`;

let server: Server;
let browser: Browser;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(req.url === "/other" ? "<html><body>other page</body></html>" : PAGE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(PORT, "localhost", resolve));
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function newGuardedPage() {
  const logger = createLogger();
  const events: SafetyEvent[] = [];
  const context = await browser.newContext();
  await installRouteGuard(context, ALLOWED_ORIGINS, logger, (e) => events.push(e));
  const page = await context.newPage();
  installPopupGuard(context, ALLOWED_ORIGINS, logger, (e) => events.push(e));
  installAsyncRedirectGuard(page, ALLOWED_ORIGINS, logger, (e) => events.push(e));
  await page.goto(ORIGIN + "/");
  return { context, page, events };
}

describe("off-origin navigation defense (real browser)", () => {
  it("allows ordinary same-origin navigation to succeed", async () => {
    const { context, page } = await newGuardedPage();
    await page.click("#onsite");
    await page.waitForLoadState("domcontentloaded");
    expect(page.url()).toBe(ORIGIN + "/other");
    await context.close();
  });

  it("blocks a click-induced off-origin navigation and keeps the page on-origin", async () => {
    const { context, page, events } = await newGuardedPage();
    await page.click("#offsite");
    await page.waitForTimeout(800);
    expect(new URL(page.url()).origin).toBe(ORIGIN);
    expect(events.some((e) => e.code === "SAFETY_NAVIGATION_BLOCKED")).toBe(true);
    await context.close();
  });

  it("blocks an off-origin form submission", async () => {
    const { context, page } = await newGuardedPage();
    await page.click("#offform-submit");
    await page.waitForTimeout(800);
    expect(new URL(page.url()).origin).toBe(ORIGIN);
    await context.close();
  });

  it("closes a popup/new tab and blocks its off-origin navigation", async () => {
    const { context, page, events } = await newGuardedPage();
    await page.click("#popupbtn");
    await page.waitForTimeout(500);
    // The popup's own off-origin request is typically aborted by the route
    // guard (layer 1) before the popup guard (layer 4) ever observes a real
    // URL for it -- either way, the popup must not remain open, and at
    // least one SAFETY_NAVIGATION_BLOCKED event must have been recorded.
    expect(context.pages()).toHaveLength(1);
    expect(events.some((e) => e.code === "SAFETY_NAVIGATION_BLOCKED")).toBe(true);
    await context.close();
  });
});
