import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read from the source fixture/ directory (not __dirname) so this works
// both run directly and from the compiled dist/ output, without a
// separate asset-copy build step for these static HTML files.
const FIXTURE_DIR = join(process.cwd(), "fixture");
function readPage(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf-8");
}

const PAGES: Record<string, string> = {
  "/": readPage("home.html"),
  "/form": readPage("form.html"),
  "/payment": readPage("payment.html"),
  "/account": readPage("account.html"),
  "/help": readPage("help.html"),
  "/expected-failure": readPage("expected-failure.html"),
};

export type FixtureServer = {
  close: () => Promise<void>;
  port: number;
};

/**
 * A tiny multi-page static server for the seeded-bug fixture (6 pages, 6
 * deterministic seeded defects — see fixture/ground-truth.json — plus one
 * deliberately reproducible non-defect on /expected-failure, documented in
 * fixture/requirements.json and never added to ground truth). POST routes
 * back the duplicate-request, http-failure, and ui-api-consistency
 * oracles. Never contacts any external system.
 *
 * `port` defaults to 0 (OS-assigned) -- pass a literal port only when a
 * caller has an inherent ordering constraint (e.g. `runPipeline()`'s
 * local-fixture auto-start, which derives the port from `config.target.url`
 * before this server exists). The actual bound port is always returned on
 * the result so callers using 0 can read it back.
 */
export function startFixtureServer(port = 0): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";

      if (method === "GET" && url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === "GET" && url in PAGES) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGES[url]);
        return;
      }

      // SEED-004 surface: always succeeds, so two rapid clicks reliably
      // produce two matching requests for the duplicate-request oracle.
      if (method === "POST" && url === "/api/submit") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        return;
      }

      // SEED-003: always fails, so the http-failure oracle has a
      // deterministic 500 to detect.
      if (method === "POST" && url === "/api/pay-fail") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"ok":false,"error":"simulated payment failure"}');
        return;
      }

      // SEED-006: always fails, but payment.html's second form incorrectly
      // shows "Payment successful" regardless -- the ui-api-consistency
      // oracle's genuine target.
      if (method === "POST" && url === "/api/payment-consistency") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"ok":false,"error":"simulated payment consistency failure"}');
        return;
      }

      // False-positive challenge surface (fixture/requirements.json REQ-001):
      // always fails, and expected-failure.html correctly shows a documented
      // "Service temporarily unavailable" message -- reproducible, but not a
      // defect. Never added to ground-truth.json.
      if (method === "POST" && url === "/api/simulated-outage") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"ok":false,"error":"simulated service outage"}');
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    server.once("error", reject);
    server.listen(port, "localhost", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}
