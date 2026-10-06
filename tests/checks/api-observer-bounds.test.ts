import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { OBSERVER_CANARIES, startObserverFixture, type ObserverFixture } from "../../fixture/observer-server.js";
import { ApiObserver, OBSERVER_LIMITS, templatePath, walkShape, isKnownName, safeMediaType, type ApiObservations, type ObserverLimits } from "../../src/auth/api-observer.js";

const ROUTES = ["compressed", "chunked", "big", "malformed", "delayed", "interrupted", "deep", "wide", "long", "empty", "missing", "stall", "cached", "revalidated"].map((r) => `/api/v1/${r}`);

let browser: Browser;
let servers: ObserverFixture[] = [];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser.close(); });
afterEach(async () => { await Promise.all(servers.map((s) => s.close())); servers = []; });

async function fixtures(): Promise<{ a: ObserverFixture; b: ObserverFixture }> {
  const b = await startObserverFixture();
  const a = await startObserverFixture({ otherOrigin: b.origin });
  servers.push(a, b);
  return { a, b };
}

/** Loads the fixture page with or without an observer; returns the frozen observation when one was attached. */
async function load(a: ObserverFixture, b: ObserverFixture, observe: boolean, limits: Partial<ObserverLimits> = {}, path = "/members/jane-doe-canary/home"): Promise<{ page: Page; observations?: ApiObservations; observer?: ApiObserver }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const observer = observe ? new ApiObserver([a.origin, b.origin], [], { routeTemplates: ROUTES }, limits) : undefined;
  observer?.attach(page);
  observer?.start();
  await page.goto(`${a.origin}${path}`);
  if (path.includes("members")) await page.waitForFunction(() => document.title === "done", undefined, { timeout: 15_000 });
  return { page, ...(observer ? { observer } : {}) };
}

const endpoint = (o: ApiObservations, origin: string, pathTemplate: string) => o.endpoints.find((e) => e.origin === origin && e.pathTemplate === pathTemplate);
const reasons = (o: ApiObservations, origin: string, pathTemplate: string) => endpoint(o, origin, pathTemplate)?.omissions.map((x) => x.reason) ?? [];

describe("API observer: names, templates and traversal bounds (unit)", () => {
  it("keeps only generic or configured names and masks personal-looking or id-like ones", () => {
    expect(isKnownName("pageSize")).toBe(true);
    expect(isKnownName("available-accounts")).toBe(true);
    expect(isKnownName("janeDoe")).toBe(false);
    expect(isKnownName("janeDoe", new Set(["janeDoe"]))).toBe(true);
    expect(isKnownName("12345678")).toBe(false);
    expect(templatePath("/api/v1/users/jane-doe/profile")).toBe("/api/v1/users/{seg}/profile");
    expect(templatePath("/api/v1/accounts/123456/transactions")).toBe("/api/v1/accounts/{id}/transactions");
    expect(templatePath("/api/v1/users/jane@example.test")).toBe("/api/v1/users/{id}");
    expect(templatePath("/api/v1/accounts/QUJDREVGR0hJSktMTU5PUFFSU1RVVldY")).toBe("/api/v1/accounts/{id}");
    expect(templatePath("/api/v1/rates/currencies")).toBe("/api/v1/rates/currencies");
    expect(templatePath("/api/v1/widgets/jane", ["/api/v1/widgets/{widgetId}"])).toBe("/api/v1/widgets/{widgetId}");
    expect(safeMediaType("application/json; charset=utf-8")).toBe("application/json");
    expect(safeMediaType("application/x-jane-doe")).toBe("other");
  });

  it("stops a wide object at the property limit and any walk at the shared node limit", () => {
    const wide = walkShape(Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`k${i}`, i])));
    expect(wide.nodesVisited).toBe(OBSERVER_LIMITS.maxPropertiesPerObject + 1);
    expect([...wide.omissions]).toContain("properties-limit");
    const many = walkShape({ items: Array.from({ length: 3 }, () => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, { a: 1, b: 2 }]))) }, new Set(), { ...OBSERVER_LIMITS, maxNodesVisited: 25 });
    expect(many.nodesVisited).toBe(25);
    expect([...many.omissions]).toContain("nodes-limit");
    const empty = walkShape({ items: [] });
    expect(Object.fromEntries([...empty.paths].map(([k, v]) => [k, [...v]]))).toEqual({ $: ["object"], "$.items": ["array"] });
  });
});

describe("API observer: passive, bounded and private against a real browser", () => {
  it("adds no requests: observer on and off produce the same server traffic", async () => {
    const { a, b } = await fixtures();
    const off = await load(a, b, false);
    await off.page.context().close();
    const offLog = [...a.requestLog].sort();
    const offOther = [...b.requestLog].sort();
    a.requestLog.length = 0; b.requestLog.length = 0;
    const on = await load(a, b, true);
    await on.observer!.stop();
    await on.page.context().close();
    expect([...a.requestLog].sort()).toEqual(offLog);
    expect([...b.requestLog].sort()).toEqual(offOther);
  }, 60_000);

  it("records metadata, bounded shapes and structured omissions, separating origins", async () => {
    const { a, b } = await fixtures();
    const { page, observer } = await load(a, b, true);
    const o = await observer!.stop();
    await page.context().close();
    expect(o.drain).toBe("drained");
    // Same path on two approved origins stays two observations.
    expect(endpoint(o, a.origin, "/api/v1/rates/currencies")).toBeDefined();
    expect(endpoint(o, b.origin, "/api/v1/rates/currencies")).toBeDefined();
    const rates = endpoint(o, a.origin, "/api/v1/rates/currencies")!;
    expect(rates.shape["$.items[*].code"]).toEqual({ types: ["string"], seenIn: 1 });
    expect(rates.queryNames).toEqual(["sourceCurrency", "<param#1>"]);
    expect(rates.seenOnPages).toEqual(["/{seg}/{seg}/home"]);
    // Compressed: honest Content-Length, unknown decoded size -> metadata only.
    expect(reasons(o, a.origin, "/api/v1/compressed")).toEqual(["body-size-unknown-compressed"]);
    expect(endpoint(o, a.origin, "/api/v1/compressed")!.samplesWithBody).toBe(0);
    // No Content-Length (chunked identity): the encoded size from Playwright still bounds it.
    expect(endpoint(o, a.origin, "/api/v1/chunked")!.samplesWithBody).toBe(1);
    expect(reasons(o, a.origin, "/api/v1/big")).toEqual(["body-too-large"]);
    expect(reasons(o, a.origin, "/api/v1/malformed")).toEqual(["malformed-json"]);
    expect(endpoint(o, a.origin, "/api/v1/delayed")!.samplesWithBody).toBe(1);
    expect(endpoint(o, a.origin, "/api/v1/interrupted")!.samplesWithBody).toBe(0);
    expect(reasons(o, a.origin, "/api/v1/interrupted").some((r) => ["interrupted", "body-unavailable", "body-size-unknown", "body-size-mismatch"].includes(r))).toBe(true);
    expect(reasons(o, a.origin, "/api/v1/deep")).toContain("depth-limit");
    expect(reasons(o, a.origin, "/api/v1/wide")).toContain("properties-limit");
    expect(Object.keys(endpoint(o, a.origin, "/api/v1/wide")!.shape).length).toBeLessThanOrEqual(OBSERVER_LIMITS.maxPropertiesPerObject + 1);
    expect(reasons(o, a.origin, "/api/v1/long")).toContain("array-sampled");
    expect(endpoint(o, a.origin, "/api/v1/empty")!.emptyArrays).toEqual(["$.items"]);
    expect(reasons(o, a.origin, "/api/v1/missing")).toEqual(["non-2xx"]);
    // A masked segment makes the template ambiguous; two raw paths merged into it.
    const users = endpoint(o, a.origin, "/api/v1/users/{seg}/profile")!;
    expect(users).toMatchObject({ ambiguous: true, mergedDistinctPaths: true, observations: 2 });
    expect(Object.keys(users.shape)).toContain("$.<field#0>");
    expect(endpoint(o, a.origin, "/api/v1/accounts/{id}")).toMatchObject({ ambiguous: false, mergedDistinctPaths: true });
  }, 60_000);

  it("keeps the serialized artifact within its byte bound and says it was truncated", async () => {
    const { a, b } = await fixtures();
    const { page, observer } = await load(a, b, true, { maxArtifactBytes: 6_000 });
    const o = await observer!.stop();
    await page.context().close();
    expect(o.artifactTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(o))).toBeLessThanOrEqual(6_000);
  }, 60_000);

  it("never persists canaries from values, names, path segments, query values or the page path", async () => {
    const { a, b } = await fixtures();
    const { page, observer } = await load(a, b, true);
    const text = JSON.stringify(await observer!.stop());
    await page.context().close();
    for (const canary of OBSERVER_CANARIES) expect(text).not.toContain(canary);
    for (const fragment of ["jane", "john", "QUJDREVG", "0f1e2d3c"]) expect(text.toLowerCase()).not.toContain(fragment.toLowerCase());
  }, 60_000);

  it("never acquires a body whose decoded size is not known within the bound", async () => {
    const { a, b } = await fixtures();
    const context = await browser.newContext();
    const page = await context.newPage();
    const acquired: string[] = [];
    // Count every body() acquisition by URL (wrapping the client Response prototype for this test only).
    const patched = new Promise<void>((resolve) => page.once("response", (r) => {
      const proto = Object.getPrototypeOf(r) as { body: () => Promise<Buffer>; __wrapped?: boolean };
      if (!proto.__wrapped) {
        const original = proto.body;
        proto.body = function (this: { url(): string }) { acquired.push(new URL(this.url()).pathname); return original.call(this); };
        proto.__wrapped = true;
      }
      resolve();
    }));
    const observer = new ApiObserver([a.origin, b.origin], [], { routeTemplates: ROUTES });
    observer.attach(page);
    observer.start();
    await page.goto(`${a.origin}/members/jane-doe-canary/home`);
    await patched;
    await page.waitForFunction(() => document.title === "done", undefined, { timeout: 15_000 });
    await observer.stop();
    await context.close();
    expect(acquired).not.toContain("/api/v1/compressed");
    expect(acquired).not.toContain("/api/v1/big");
    expect(acquired).not.toContain("/api/v1/missing");
  }, 60_000);

  it("bounds concurrency and queue length, and stop() drains within its timeout and freezes the result", async () => {
    const { a, b } = await fixtures();
    const context = await browser.newContext();
    const page = await context.newPage();
    const observer = new ApiObserver([a.origin], [], { routeTemplates: ROUTES }, { maxConcurrent: 1, maxQueue: 1, drainTimeoutMs: 300, responseTimeoutMs: 10_000 });
    observer.attach(page);
    observer.start();
    await page.goto(`${a.origin}/stall-page`);
    await expect.poll(() => observer.summary().endpoints[0]?.observations ?? 0, { timeout: 10_000 }).toBe(4);
    const started = Date.now();
    const frozen = await observer.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(frozen.drain).toBe("drain-timeout");
    const stall = endpoint(frozen, a.origin, "/api/v1/stall")!;
    expect(stall.omissions).toEqual([{ reason: "queue-full", count: 2 }]);
    expect(frozen.responsesSkipped).toEqual([{ reason: "interrupted", count: 1 }]);
    // Listeners are detached: later traffic changes nothing.
    await page.goto(`${a.origin}/stall-page`).catch(() => {});
    await page.waitForTimeout(300);
    expect(observer.summary()).toBe(frozen);
    await context.close();
    void b;
  }, 60_000);

  it("attributes a response to the page that made the request and flags a navigation in between", async () => {
    const { a, b } = await fixtures();
    const context = await browser.newContext();
    const page = await context.newPage();
    const observer = new ApiObserver([a.origin], [], { routeTemplates: ROUTES });
    observer.attach(page);
    observer.start();
    await page.goto(`${a.origin}/statements`);
    await page.waitForFunction(() => document.title === "done", undefined, { timeout: 15_000 });
    const o = await observer.stop();
    await context.close();
    const delayed = endpoint(o, a.origin, "/api/v1/delayed")!;
    expect(delayed.seenOnPages).toEqual(["/statements"]);
    expect(delayed.omissions).toEqual([{ reason: "page-attribution-uncertain", count: 1 }]);
    void b;
  }, 60_000);

  it("never reads a cached or revalidated body: nothing received over the network bounds it", async () => {
    const { a, b } = await fixtures();
    const context = await browser.newContext();
    const page = await context.newPage();
    const acquired: string[] = [];
    page.once("response", (r) => {
      const proto = Object.getPrototypeOf(r) as { body: () => Promise<Buffer>; __cacheWrapped?: boolean };
      if (proto.__cacheWrapped) return;
      const original = proto.body;
      proto.body = function (this: { url(): string }) { acquired.push(new URL(this.url()).pathname); return original.call(this); };
      proto.__cacheWrapped = true;
    });
    const observer = new ApiObserver([a.origin], [], { routeTemplates: ROUTES });
    observer.attach(page);
    observer.start();
    await page.goto(`${a.origin}/cache-page`);
    await page.waitForFunction(() => document.title === "done", undefined, { timeout: 15_000 });
    const o = await observer.stop();
    await context.close();
    expect(a.hits.get("GET /api/v1/cached")).toBe(1); // the second answer came from the browser cache
    expect(a.hits.get("GET /api/v1/revalidated")).toBe(2); // the second was a 304 revalidation
    for (const path of ["/api/v1/cached", "/api/v1/revalidated"]) {
      expect(endpoint(o, a.origin, path)).toMatchObject({ observations: 2, samplesWithBody: 1, omissions: [{ reason: "body-size-unknown", count: 1 }] });
      expect(acquired.filter((p) => p === path)).toHaveLength(1);
    }
    void b;
  }, 60_000);

  it("detaches every listener it added when stopped", async () => {
    const { a, b } = await fixtures();
    const context = await browser.newContext();
    const page = await context.newPage();
    const events = ["request", "response", "framenavigated", "requestfailed"] as const;
    // Page is an EventEmitter at runtime; its type does not declare listenerCount.
    const emitter = page as unknown as { listenerCount(event: string): number };
    const counts = () => events.map((e) => emitter.listenerCount(e));
    const before = counts();
    const observer = new ApiObserver([a.origin]);
    observer.attach(page);
    expect(counts()).toEqual(before.map((n) => n + 1));
    await observer.stop();
    expect(counts()).toEqual(before);
    await context.close();
    void b;
  }, 60_000);

  it("records responses served by a service worker as metadata only", async () => {
    const { a, b } = await fixtures();
    const context = await browser.newContext();
    const page = await context.newPage();
    const observer = new ApiObserver([a.origin], [], { routeTemplates: [...ROUTES, "/api/v1/sw-served"] });
    observer.attach(page);
    observer.start();
    await page.goto(`${a.origin}/sw-page`);
    await page.waitForFunction(() => document.title !== "loading", undefined, { timeout: 15_000 });
    expect(await page.title()).toBe("done");
    const o = await observer.stop();
    await context.close();
    const sw = endpoint(o, a.origin, "/api/v1/sw-served")!;
    expect(sw).toMatchObject({ fromServiceWorker: true, samplesWithBody: 0 });
    expect(sw.omissions).toEqual([{ reason: "from-service-worker", count: 1 }]);
    expect(JSON.stringify(o)).not.toContain("CANARYSW55");
    void b;
  }, 60_000);
});
