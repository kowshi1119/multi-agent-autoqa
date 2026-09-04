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
};

export type FixtureServer = {
  close: () => Promise<void>;
};

/**
 * A tiny multi-page static server for the seeded-bug fixture (5 pages, 5
 * deterministic seeded defects — see fixture/ground-truth.json). Two POST
 * routes back the duplicate-request and http-failure oracles. Never
 * contacts any external system.
 */
export function startFixtureServer(port: number): Promise<FixtureServer> {
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

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    server.once("error", reject);
    server.listen(port, "localhost", () => {
      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}
