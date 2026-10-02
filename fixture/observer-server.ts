import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";

/**
 * Synthetic edge cases for the passive API observer (tests only). One page
 * whose own script calls every endpoint once, so an observer-on run and an
 * observer-off run can be compared request for request. Values, keys, path
 * segments, query values and the page path carry CANARY markers that must
 * never appear in an observation artifact. Never contacts anything external.
 */
export const OBSERVER_CANARIES = ["CANARYVALUE7f3a", "canaryKeyJane", "jane-canary-seg", "CANARYQUERY91", "jane-doe-canary", "CANARYSW55"] as const;

export type ObserverFixture = { origin: string; hits: Map<string, number>; requestLog: string[]; close(): Promise<void> };

const WIDE = Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`k${i}`, i]));
const deep = (n: number): unknown => (n === 0 ? { status: "CANARYVALUE7f3a" } : { data: deep(n - 1) });

/** Endpoints the page calls (paths relative to the page's origin unless `other` is given). */
export function observerPageScript(otherOrigin?: string): string {
  const calls = [
    "/api/v1/rates/currencies?sourceCurrency=CANARYQUERY91&canaryKeyJane=1",
    "/api/v1/compressed",
    "/api/v1/chunked",
    "/api/v1/big",
    "/api/v1/malformed",
    "/api/v1/delayed",
    "/api/v1/interrupted",
    "/api/v1/deep",
    "/api/v1/wide",
    "/api/v1/long",
    "/api/v1/empty",
    "/api/v1/missing",
    "/api/v1/users/jane-canary-seg/profile",
    "/api/v1/users/john-canary-seg/profile",
    "/api/v1/accounts/QUJDREVGR0hJSktMTU5PUFFSU1RVVldY",
    "/api/v1/accounts/0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  ];
  const urls = [...calls, ...(otherOrigin ? [`${otherOrigin}/api/v1/rates/currencies`] : [])];
  return `<script>
Promise.allSettled(${JSON.stringify(urls)}.map(function (u) { return fetch(u).then(function (r) { return r.text(); }); }))
  .then(function () { document.title = "done"; });
</script>`;
}

export function startObserverFixture(options: { otherOrigin?: string; stallCount?: number } = {}): Promise<ObserverFixture> {
  const hits = new Map<string, number>();
  const requestLog: string[] = [];
  const cors = { "Access-Control-Allow-Origin": "*" };
  const json = (res: import("node:http").ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void => {
    const body = JSON.stringify(value);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(body)), ...cors, ...extra });
    res.end(body);
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://observer.invalid");
    const path = url.pathname;
    hits.set(`${req.method} ${path}`, (hits.get(`${req.method} ${path}`) ?? 0) + 1);
    requestLog.push(`${req.method} ${req.url}`);
    if (path === "/members/jane-doe-canary/home") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>loading</title></head><body><h1>Observer fixture</h1>${observerPageScript(options.otherOrigin)}</body></html>`);
      return;
    }
    if (path === "/stall-page") {
      const n = options.stallCount ?? 4;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><script>for (var i = 0; i < ${n}; i++) fetch("/api/v1/stall?i=" + i);</script></body></html>`);
      return;
    }
    if (path === "/statements") {
      // Client-side navigation while a request is in flight: the response arrives after the URL changed.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>loading</title></head><body><script>
var p = fetch("/api/v1/delayed").then(function (r) { return r.text(); });
history.pushState({}, "", "/home");
p.then(function () { document.title = "done"; });
</script></body></html>`);
      return;
    }
    if (path === "/sw-page") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>loading</title></head><body><script>
navigator.serviceWorker.register("/sw.js").then(function () { return navigator.serviceWorker.ready; })
  .then(function () { return new Promise(function (r) { if (navigator.serviceWorker.controller) r(); else navigator.serviceWorker.addEventListener("controllerchange", r); }); })
  .then(function () { return fetch("/api/v1/sw-served").then(function (r) { return r.text(); }); })
  .then(function () { document.title = "done"; }, function () { document.title = "sw-failed"; });
</script></body></html>`);
      return;
    }
    if (path === "/sw.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(`self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) { if (new URL(e.request.url).pathname === "/api/v1/sw-served") e.respondWith(new Response(JSON.stringify({ status: "CANARYSW55" }), { headers: { "Content-Type": "application/json" } })); });`);
      return;
    }
    switch (path) {
      case "/api/v1/rates/currencies": json(res, 200, { items: [{ code: "XXX", name: "CANARYVALUE7f3a" }], total: 1 }); return;
      case "/api/v1/compressed": {
        // Content-Length is honest about the encoded bytes (RFC 9110 §8.6) but
        // says nothing about the 2 MB the body decodes to.
        const body = gzipSync(JSON.stringify({ status: "ok", padding: "a".repeat(2_000_000) }));
        res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": String(body.length), ...cors });
        res.end(body);
        return;
      }
      case "/api/v1/chunked": res.writeHead(200, { "Content-Type": "application/json", ...cors }); res.write('{"status":'); res.end('"CANARYVALUE7f3a","total":3}'); return;
      case "/api/v1/big": json(res, 200, { data: "b".repeat(1_000_000) }); return;
      case "/api/v1/malformed": res.writeHead(200, { "Content-Type": "application/json", ...cors }); res.end('{"status": "CANARYVALUE7f3a", '); return;
      case "/api/v1/delayed": setTimeout(() => json(res, 200, { status: "late" }), 300); return;
      case "/api/v1/interrupted": res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "5000", ...cors }); res.write('{"status":'); setTimeout(() => res.destroy(), 50); return;
      case "/api/v1/deep": json(res, 200, deep(20)); return;
      case "/api/v1/wide": json(res, 200, WIDE); return;
      case "/api/v1/long": json(res, 200, { items: Array.from({ length: 10_000 }, (_, i) => ({ id: i })) }); return;
      case "/api/v1/empty": json(res, 200, { items: [], total: 0 }); return;
      case "/api/v1/missing": json(res, 404, { error: "CANARYVALUE7f3a" }); return;
      case "/api/v1/users/jane-canary-seg/profile":
      case "/api/v1/users/john-canary-seg/profile": json(res, 200, { canaryKeyJane: { status: "CANARYVALUE7f3a" }, status: "active" }); return;
      case "/api/v1/stall": res.writeHead(200, { "Content-Type": "application/json", ...cors }); res.write('{"status":'); return; // never finishes
      default:
        if (path.startsWith("/api/v1/accounts/")) { json(res, 200, { id: "CANARYVALUE7f3a" }); return; }
        res.writeHead(404, { "Content-Type": "text/plain", ...cors }); res.end("Not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ origin: `http://localhost:${port}`, hits, requestLog, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) });
    });
  });
}
