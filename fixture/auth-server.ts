import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Synthetic cookie-session target for run-scoped authenticated checks and
 * read-only workflow discovery. Separate from fixture/server.ts so the
 * canonical six-defect ground truth is untouched. Two seeded SYNTHETIC
 * accounts only; sessions live in process memory and die with the server.
 * Never contacts anything external.
 */
export const AUTH_FIXTURE_ACCOUNTS = {
  "demo-a": { password: "demo-a-synthetic-password", email: "demo-a@example.invalid", role: "member" },
  "demo-b": { password: "demo-b-synthetic-password", email: "demo-b@example.invalid", role: "member" },
} as const;
type AccountId = keyof typeof AUTH_FIXTURE_ACCOUNTS;

export type AuthFixtureOptions = {
  port?: number;
  /** Authenticated API requests allowed per session before it is invalidated (401) -- simulates expiry mid-run. */
  sessionMaxRequests?: number;
  /** Where /api/redirect-offsite points. */
  offsiteUrl?: string;
  /** Total time /api/slow-body takes to stream its body. */
  slowBodyMs?: number;
};

export type AuthFixtureServer = {
  port: number;
  origin: string;
  /** Request counts by "METHOD /path", so tests can prove a denied request never arrived. */
  hits: Map<string, number>;
  /** Invalidates every live session (next request gets 401 / redirect to login). */
  expireAllSessions(): void;
  close(): Promise<void>;
};

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const LOGIN_PAGE = page("Sign in", `<h1>Sign in to Demo Bank</h1>
<form id="f"><label for="u">Username</label><input id="u" name="username" autocomplete="off">
<label for="p">Password</label><input id="p" name="password" type="password">
<button type="submit">Sign in</button></form><p id="err" role="alert"></p>
<script>
document.getElementById("f").addEventListener("submit", function (e) {
  e.preventDefault();
  fetch("/session", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: document.getElementById("u").value, password: document.getElementById("p").value }) })
    .then(function (r) { if (r.ok) location.href = "/home"; else document.getElementById("err").textContent = "Sign-in failed"; });
});
</script>`);

const HOME_PAGE = page("Home", `<h1>Demo Home</h1>
<nav aria-label="Main">
  <a href="/statements">Statements</a>
  <a href="/profile">Profile</a>
  <a href="/help">Help</a>
  <a href="/activity">Activity</a>
  <a href="/settings/delete-account">Delete account</a>
  <a href="/transfers/new">Send money</a>
  <a href="/logout">Log out</a>
  <a href="https://example.invalid/partner">Partner offers</a>
</nav>`);

const AUTH_PAGES: Record<string, string> = {
  "/home": HOME_PAGE,
  "/statements": page("Statements", `<h1>Statements</h1><table><tr><th>Date</th><th>Amount</th></tr><tr><td>2026-09-01</td><td>10.00</td></tr></table><a href="/home">Back to home</a>`),
  "/profile": page("Profile", `<h1>Your profile</h1><p>Synthetic member profile.</p><a href="/home">Back to home</a>`),
  "/help": page("Help", `<h1>Help centre</h1><p>Synthetic help text.</p><a href="/home">Back to home</a>`),
  // Negative control: loads fine but has no heading/landmark, so discovery
  // must NOT propose a workflow for it (success is never inferred from a click).
  "/activity": page("Activity", `<div>Recent activity is loading…</div><a href="/home">Back to home</a>`),
  "/settings/delete-account": page("Delete account", `<h1>Delete account</h1><button>Delete permanently</button>`),
  "/transfers/new": page("Send money", `<h1>Send money</h1><button>Send</button>`),
};

function readBody(req: IncomingMessage, limit = 16_384): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
      if (body.length > limit) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}

export function startAuthFixtureServer(options: AuthFixtureOptions = {}): Promise<AuthFixtureServer> {
  const sessions = new Map<string, { account: AccountId; apiRequests: number }>();
  const hits = new Map<string, number>();
  const slowBodyMs = options.slowBodyMs ?? 5_000;

  const sessionFor = (req: IncomingMessage) => {
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    return sid ? { sid, session: sessions.get(sid) } : undefined;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0] as string;
      hits.set(`${method} ${path}`, (hits.get(`${method} ${path}`) ?? 0) + 1);

      if (method === "GET" && (path === "/" || path === "/login")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(LOGIN_PAGE);
        return;
      }
      if (method === "GET" && path === "/favicon.ico") { res.writeHead(204); res.end(); return; }

      if (method === "POST" && path === "/session") {
        let parsed: { username?: string; password?: string } = {};
        try { parsed = JSON.parse(await readBody(req)) as typeof parsed; } catch { /* rejected below */ }
        const account = parsed.username as AccountId | undefined;
        if (!account || !(account in AUTH_FIXTURE_ACCOUNTS) || AUTH_FIXTURE_ACCOUNTS[account].password !== parsed.password) {
          json(res, 401, { error: "invalid credentials" });
          return;
        }
        const sid = randomBytes(18).toString("hex");
        sessions.set(sid, { account, apiRequests: 0 });
        res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `sid=${sid}; HttpOnly; SameSite=Lax; Path=/` });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const current = sessionFor(req);

      if (method === "GET" && path === "/logout") {
        if (current) sessions.delete(current.sid);
        res.writeHead(302, { Location: "/login", "Set-Cookie": "sid=; Max-Age=0; Path=/" });
        res.end();
        return;
      }

      if (method === "GET" && path in AUTH_PAGES) {
        if (!current?.session) { res.writeHead(302, { Location: "/login" }); res.end(); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(AUTH_PAGES[path]);
        return;
      }

      if (path.startsWith("/api/")) {
        // Redirect probes answer before authentication, like a gateway would.
        if (method === "GET" && path === "/api/redirect-login") { res.writeHead(302, { Location: "/login" }); res.end(); return; }
        if (method === "GET" && path === "/api/redirect-offsite") { res.writeHead(302, { Location: options.offsiteUrl ?? "http://127.0.0.1:1/offsite" }); res.end(); return; }

        const session = current?.session;
        if (!session) { json(res, 401, { error: "not authenticated" }); return; }
        session.apiRequests++;
        if (options.sessionMaxRequests !== undefined && session.apiRequests > options.sessionMaxRequests) {
          sessions.delete(current!.sid);
          json(res, 401, { error: "session expired" });
          return;
        }
        const account = AUTH_FIXTURE_ACCOUNTS[session.account];

        if (method === "GET" && path === "/api/me") { json(res, 200, { id: session.account, email: account.email, role: account.role }); return; }
        if (method === "GET" && path === "/api/statements") { json(res, 200, { owner: session.account, count: 2, items: [{ id: "st-1", amount: 10 }, { id: "st-2", amount: 25 }] }); return; }
        if (method === "GET" && path === "/api/big") { json(res, 200, { owner: session.account, padding: "x".repeat(2_000_000) }); return; }
        if (method === "GET" && path === "/api/slow-body") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.write('{"chunks":[');
          const steps = 20;
          let sent = 0;
          const timer = setInterval(() => {
            if (res.destroyed) { clearInterval(timer); return; }
            sent++;
            res.write(sent === 1 ? "0" : `,${sent}`);
            if (sent >= steps) { clearInterval(timer); res.end("]}"); }
          }, Math.max(1, Math.floor(slowBodyMs / steps)));
          req.on("close", () => clearInterval(timer));
          return;
        }
        if (method === "POST" && path === "/api/transfer") { json(res, 200, { ok: true, warning: "synthetic mutation endpoint; must never be reached" }); return; }
        json(res, 404, { error: "not found" });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    })().catch(() => { if (!res.headersSent) { res.writeHead(500); } res.end(); });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "localhost", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port ?? 0;
      resolve({
        port,
        origin: `http://localhost:${port}`,
        hits,
        expireAllSessions: () => sessions.clear(),
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}
