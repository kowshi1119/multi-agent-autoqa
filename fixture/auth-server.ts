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
  /** Authenticated page views allowed per session before it is invalidated (redirect to login) -- simulates expiry mid-workflow. */
  sessionMaxPageViews?: number;
  /** "bearer": API routes accept only `Authorization: Bearer <token>` (sent by the app's own page script), never the cookie. */
  apiAuth?: "cookie" | "bearer";
  /** Known-bug variants for negative tests; can also be changed at runtime with setBugs(). */
  bugs?: FixtureBugs;
};

/** Runtime-switchable variants: known application bugs, plus a page-view session limit for expiry-mid-workflow tests. */
export type FixtureBugs = { searchIgnoresQuery?: boolean; filterIgnored?: boolean; detailWrongHeading?: boolean; sessionMaxPageViews?: number };

/** Twelve synthetic statements; first words are unique so a one-word search narrows to exactly one record. */
export const FIXTURE_STATEMENTS = ["Coffee House", "Book Nook", "Grocery Mart", "City Transit", "Fuel Stop", "Pharmacy Plus", "Cinema Hall", "Garden Centre", "Bakery Lane", "Music Shop", "Sports Depot", "Tea Corner"]
  .map((merchant, i) => ({ id: `st-${String(i + 1).padStart(2, "0")}`, merchant, status: i % 3 === 0 ? "pending" : "paid", date: `2026-09-${String(i + 1).padStart(2, "0")}`, amount: ((i + 1) * 7.5).toFixed(2) }));
const PAGE_SIZE = 5;
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function statementsPage(url: URL, bugs: FixtureBugs): string {
  const q = bugs.searchIgnoresQuery ? "" : (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const status = bugs.filterIgnored ? "" : url.searchParams.get("status") ?? "";
  const pageNo = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const matching = FIXTURE_STATEMENTS.filter((s) => (!q || s.merchant.toLowerCase().includes(q)) && (!status || s.status === status));
  const rows = matching.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE);
  const keep = new URLSearchParams();
  if (url.searchParams.get("q")) keep.set("q", url.searchParams.get("q") as string);
  if (url.searchParams.get("status")) keep.set("status", url.searchParams.get("status") as string);
  const pageLink = (n: number, label: string) => { const p = new URLSearchParams(keep); p.set("page", String(n)); return `<a href="/statements?${p}">${label}</a>`; };
  const shownQ = escapeHtml(url.searchParams.get("q") ?? "");
  return page("Statements", `<h1>Statements</h1>
<form method="get" action="/statements" role="search" aria-label="Statement search">
  <label for="q">Search statements</label><input id="q" name="q" type="search" value="${shownQ}">
  <label for="status">Status</label><select id="status" name="status"><option value="">All</option><option value="paid"${status === "paid" ? " selected" : ""}>Paid</option><option value="pending"${status === "pending" ? " selected" : ""}>Pending</option></select>
  <button type="submit">Search</button>
</form>
<nav aria-label="Status filter"><a href="/statements?status=paid">Paid only</a> <a href="/statements?status=pending">Pending only</a></nav>
<table aria-label="Statement results"><thead><tr><th>Date</th><th>Merchant</th><th>Amount</th></tr></thead><tbody>
${rows.map((s) => `<tr><td>${s.date}</td><td><a href="/statements/${s.id}">${s.merchant}</a></td><td>${s.amount}</td></tr>`).join("\n")}
</tbody></table>
${rows.length ? `<p>Showing ${(pageNo - 1) * PAGE_SIZE + 1}–${(pageNo - 1) * PAGE_SIZE + rows.length} of ${matching.length}</p>` : `<p role="status">No statements match your search.</p>`}
<nav aria-label="Pagination">${pageNo > 1 ? pageLink(pageNo - 1, "Previous") : ""} ${pageNo * PAGE_SIZE < matching.length ? pageLink(pageNo + 1, "Next") : ""}</nav>
<a href="/home">Back to home</a>`);
}

function statementDetailPage(id: string, bugs: FixtureBugs): string | undefined {
  const statement = FIXTURE_STATEMENTS.find((s) => s.id === id);
  if (!statement) return undefined;
  return page(`Statement ${id}`, `<h1>${bugs.detailWrongHeading ? "Statement details" : `Statement ${id}`}</h1><p>Merchant: ${statement.merchant}</p><p>Status: ${statement.status}</p><a href="/statements">Back to statements</a>`);
}

export type AuthFixtureServer = {
  port: number;
  origin: string;
  /** Request counts by "METHOD /path", so tests can prove a denied request never arrived. */
  hits: Map<string, number>;
  /** Every request as "METHOD /path?query", in arrival order -- lets tests prove a form was never submitted. */
  requestLog: string[];
  /** Bearer tokens issued this server lifetime -- lets tests prove no token value was persisted. */
  issuedTokens: string[];
  /** Invalidates every live session (next request gets 401 / redirect to login). */
  expireAllSessions(): void;
  /** Switches known-bug variants on or off, e.g. after discovery and before execution. */
  setBugs(bugs: FixtureBugs): void;
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
    .then(function (r) { return r.json().then(function (d) { if (r.ok) { if (d.token) sessionStorage.setItem("demoToken", d.token); location.href = "/home"; } else document.getElementById("err").textContent = "Sign-in failed"; }); });
});
</script>`);

// The app's own client script calls its API. In bearer mode it sends the
// token it received at sign-in, like a token-based SPA; in cookie mode the
// browser sends the session cookie. AutoQA only ever observes these requests.
const HOME_SCRIPT = `<p id="who"></p><script>
var t = sessionStorage.getItem("demoToken");
fetch("/api/me", t ? { headers: { Authorization: "Bearer " + t } } : {}).then(function (r) { return r.json(); }).then(function (d) { document.getElementById("who").textContent = d.id ? "Signed in" : ""; });
</script>`;

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
/** The home page only calls the API when an API-auth mode is set explicitly, so other tests can assert the API was never touched. */
const HOME_PAGE_WITH_API_CALL = HOME_PAGE.replace("</body>", `${HOME_SCRIPT}</body>`);

const AUTH_PAGES: Record<string, string> = {
  "/home": HOME_PAGE,
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
  const sessions = new Map<string, { account: AccountId; apiRequests: number; pageViews: number; token: string }>();
  const hits = new Map<string, number>();
  const requestLog: string[] = [];
  const issuedTokens: string[] = [];
  const slowBodyMs = options.slowBodyMs ?? 5_000;
  let bugs: FixtureBugs = { ...options.bugs };

  const sessionFor = (req: IncomingMessage) => {
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    return sid ? { sid, session: sessions.get(sid) } : undefined;
  };
  const sessionForBearer = (req: IncomingMessage) => {
    const token = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) return undefined;
    for (const [sid, session] of sessions) if (session.token === token) return { sid, session };
    return undefined;
  };
  /** Counts an authenticated page view; returns false (and ends the session) once the page-view limit is exceeded. */
  const pageViewAllowed = (current: { sid: string; session: { pageViews: number } }): boolean => {
    current.session.pageViews++;
    const limit = bugs.sessionMaxPageViews ?? options.sessionMaxPageViews;
    if (limit !== undefined && current.session.pageViews > limit) { sessions.delete(current.sid); return false; }
    return true;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0] as string;
      hits.set(`${method} ${path}`, (hits.get(`${method} ${path}`) ?? 0) + 1);
      requestLog.push(`${method} ${req.url ?? "/"}`);

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
        const token = randomBytes(18).toString("hex");
        sessions.set(sid, { account, apiRequests: 0, pageViews: 0, token });
        issuedTokens.push(token);
        res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `sid=${sid}; HttpOnly; SameSite=Lax; Path=/` });
        res.end(JSON.stringify(options.apiAuth === "bearer" ? { ok: true, token } : { ok: true }));
        return;
      }

      const current = sessionFor(req);
      const requestUrl = new URL(req.url ?? "/", "http://fixture.invalid");
      const detailMatch = /^\/statements\/(st-\d{2})$/.exec(path);
      if (method === "GET" && (path === "/statements" || detailMatch)) {
        if (!current?.session || !pageViewAllowed({ sid: current.sid, session: current.session })) { res.writeHead(302, { Location: "/login" }); res.end(); return; }
        const html = path === "/statements" ? statementsPage(requestUrl, bugs) : statementDetailPage(detailMatch![1] as string, bugs);
        if (!html) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (method === "GET" && path === "/logout") {
        if (current) sessions.delete(current.sid);
        res.writeHead(302, { Location: "/login", "Set-Cookie": "sid=; Max-Age=0; Path=/" });
        res.end();
        return;
      }

      if (method === "GET" && path in AUTH_PAGES) {
        if (!current?.session || !pageViewAllowed({ sid: current.sid, session: current.session })) { res.writeHead(302, { Location: "/login" }); res.end(); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(path === "/home" && options.apiAuth ? HOME_PAGE_WITH_API_CALL : AUTH_PAGES[path]);
        return;
      }

      if (path.startsWith("/api/")) {
        // Redirect probes answer before authentication, like a gateway would.
        if (method === "GET" && path === "/api/redirect-login") { res.writeHead(302, { Location: "/login" }); res.end(); return; }
        if (method === "GET" && path === "/api/redirect-offsite") { res.writeHead(302, { Location: options.offsiteUrl ?? "http://127.0.0.1:1/offsite" }); res.end(); return; }

        const apiCurrent = options.apiAuth === "bearer" ? sessionForBearer(req) : current;
        const session = apiCurrent?.session;
        if (!session) { json(res, 401, { error: "not authenticated" }); return; }
        session.apiRequests++;
        if (options.sessionMaxRequests !== undefined && session.apiRequests > options.sessionMaxRequests) {
          sessions.delete(apiCurrent!.sid);
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
        requestLog,
        issuedTokens,
        expireAllSessions: () => sessions.clear(),
        setBugs: (next: FixtureBugs) => { bugs = { ...next }; },
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}
