import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import { installRouteGuard } from "../../src/safety/navigation-guard.js";
import type { SafetyEvent } from "../../src/types.js";

/**
 * Found on the Ajeer sandbox (RUN-20260929-093659390Z-1d47): Next.js aborts
 * in-flight prefetch/API requests on navigation and at teardown. When the
 * guard's own fetch of such a request fails in transit, the request must
 * still be aborted (never let through unvalidated), but it is not a safety
 * policy decision and must not be recorded as one -- otherwise a workflow
 * would be reported "blocked by network policy" for an ordinary cancelled
 * request.
 */
let server: Server;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/api/dropped") { req.socket.destroy(); return; }
    if (req.url === "/api/ok") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body><h1>Home</h1></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("route guard: transport failures are not policy denials", () => {
  it("aborts a request whose connection drops, without recording an ACTION_POLICY_DENIED safety event", async () => {
    const events: SafetyEvent[] = [];
    const context = await browser.newContext();
    // Every request goes through the redirect-validating path (the real-target configuration).
    await installRouteGuard(context, [origin], createLogger(), (e) => events.push(e), () => ({ decision: "allowed" as const }));
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    const outcome = await page.evaluate(async () => {
      const ok = await fetch("/api/ok").then((r) => r.status).catch(() => "failed");
      const dropped = await fetch("/api/dropped").then((r) => r.status).catch(() => "failed");
      return { ok, dropped };
    });
    expect(outcome).toEqual({ ok: 200, dropped: "failed" });
    expect(events.filter((e) => e.code === "ACTION_POLICY_DENIED")).toEqual([]);
    await context.close();
  });

  it("still records a real policy denial", async () => {
    const events: SafetyEvent[] = [];
    const context = await browser.newContext();
    await installRouteGuard(context, [origin], createLogger(), (e) => events.push(e), (_m, pathname) => pathname === "/api/ok" ? { decision: "denied" as const, reason: "test policy" } : { decision: "allowed" as const });
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    const status = await page.evaluate(() => fetch("/api/ok").then((r) => r.status).catch(() => "failed"));
    expect(status).toBe("failed");
    expect(events.filter((e) => e.code === "ACTION_POLICY_DENIED")).toHaveLength(1);
    await context.close();
  });
});
