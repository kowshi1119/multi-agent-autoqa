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
/**
 * Seeded synthetic accounts + in-memory session store for the API/security
 * check demo routes below (added 2026-09-23, additive only -- none of this
 * touches the 6 seeded ground-truth defects or their routes/pages above).
 * Tokens are opaque random-ish strings, held only in process memory, never
 * written anywhere -- this is a disposable local fixture, not a real
 * authentication system.
 */
const DEMO_ACCOUNTS: Record<string, { id: string; email: string; role: string }> = {
  "demo-a": { id: "demo-a", email: "demo-a@example.invalid", role: "member" },
  "demo-b": { id: "demo-b", email: "demo-b@example.invalid", role: "member" },
};
const demoSessions = new Map<string, string>(); // token -> accountId

function readRequestBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf-8")));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

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

      // GET /api/session-check -- a GET-reachable route that issues the
      // same weak (no SameSite) cookie /api/login-demo does, so the
      // cookie-attributes security check (which only ever fires GET) has a
      // real target to observe -- /api/login-demo itself is POST-only.
      if (method === "GET" && url === "/api/session-check") {
        res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "demo=1; Path=/" });
        res.end('{"ok":true}');
        return;
      }

      // GET /api/users/:id -- required-fields JSON shape target for the
      // API-check demo.
      const userMatch = /^\/api\/users\/([^/]+)$/.exec(url);
      if (method === "GET" && userMatch) {
        const account = DEMO_ACCOUNTS[userMatch[1] as string];
        if (!account) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(account));
        return;
      }

      // POST /api/login-demo -- issues a session cookie deliberately
      // WITHOUT SameSite, so the cookie-attribute security check has a
      // real (synthetic-only) finding to make. Body: {"accountId":"demo-a"|"demo-b"}.
      if (method === "POST" && url === "/api/login-demo") {
        void (async () => {
          let accountId: string | undefined;
          try {
            accountId = (JSON.parse(await readRequestBody(req)) as { accountId?: string }).accountId;
          } catch {
            // fall through to the 400 below
          }
          if (!accountId || !DEMO_ACCOUNTS[accountId]) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "unknown accountId" }));
            return;
          }
          const token = `demo-session-${accountId}-${Math.random().toString(36).slice(2)}`;
          demoSessions.set(token, accountId);
          res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `session=${token}; Path=/` });
          res.end(JSON.stringify({ ok: true }));
        })();
        return;
      }

      // GET /api/account/:id/resource -- gated ONLY by the session cookie's
      // OWNER, not by whether it matches :id -- deliberately vulnerable to
      // cross-account access so the session-boundary security check has a
      // real (synthetic-only) case to demonstrate. Never touches real
      // Ajeer accounts or any non-demo data.
      const resourceMatch = /^\/api\/account\/([^/]+)\/resource$/.exec(url);
      if (method === "GET" && resourceMatch) {
        const cookieHeader = req.headers.cookie ?? "";
        const sessionToken = /(?:^|;\s*)session=([^;]+)/.exec(cookieHeader)?.[1];
        const ownerId = sessionToken ? demoSessions.get(sessionToken) : undefined;
        if (!ownerId) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not authenticated" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ resourceOwner: ownerId, requestedAccountId: resourceMatch[1], secretNote: `private note for ${ownerId}` }));
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
