import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read from the source fixture/ directory (not __dirname) so this works
// both run directly and from the compiled dist/ output, without a
// separate asset-copy build step for one static HTML file.
const INDEX_HTML = readFileSync(join(process.cwd(), "fixture", "index.html"), "utf-8");

export type FixtureServer = {
  close: () => Promise<void>;
};

/**
 * Minimal single-page static server for the seeded-bug fixture. Serves only
 * the local index.html; it never contacts any external system.
 */
export function startFixtureServer(port: number): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
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
