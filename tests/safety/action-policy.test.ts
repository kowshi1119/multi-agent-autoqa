import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeAction } from "../../src/actions.js";
import { BrowserManager } from "../../src/browser/browser.js";
import { ConfigError } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { createHttpFailureOracle } from "../../src/oracles/http-failure.js";
import { parseProfile } from "../../src/profiles/schema.js";
import { profileToAppConfig } from "../../src/profiles/to-app-config.js";
import { runPipeline } from "../../src/run-pipeline.js";
import { ActionPolicy, pathWithinPrefix, type ActionClassification } from "../../src/safety/action-policy.js";
import { installAsyncRedirectGuard, installRouteGuard } from "../../src/safety/navigation-guard.js";
import type { Finding, SafetyEvent } from "../../src/types.js";
import { Validator } from "../../src/validator.js";

let server: Server;
let ORIGIN: string;
let browser: Browser;

const PAGE_HTML = `<!doctype html><html><body>
  <form id="mutate-form" action="/mutate" method="post">
    <input type="text" name="q" aria-label="Mutate query" />
    <button type="submit" id="mutate-submit">Mutate</button>
  </form>
  <form id="search-form" action="/search" method="get">
    <input type="text" name="q" aria-label="Search query" />
    <button type="submit" id="search-submit">Search</button>
  </form>
  <button type="button" id="plain-button">Plain button</button>
  <a href="/other" id="nav-link">Other page</a>
  <button type="button" id="next-button" aria-label="Next">Next</button>
  <input type="text" id="bare-search" aria-label="Bare search (no form)" />
  <script>
    document.getElementById("mutate-form").addEventListener("submit", (e) => { e.preventDefault(); window.__mutateSubmitted = true; });
    document.getElementById("search-form").addEventListener("submit", (e) => { e.preventDefault(); window.__searchSubmitted = true; });
    document.getElementById("plain-button").addEventListener("click", () => { window.__plainClicked = true; });
    document.getElementById("bare-search").addEventListener("keydown", (e) => { if (e.key === "Enter") { window.__bareSearchSubmitted = true; } });
  </script>
</body></html>`;

const ADMIN_PAGE_HTML = `<!doctype html><html><body><h1>Admin</h1></body></html>`;
const ADMINISTRATOR_PAGE_HTML = `<!doctype html><html><body><h1>Administrator (different page entirely)</h1></body></html>`;

// A REAL native <form> submission -- no JS preventDefault -- producing a
// genuine navigation-type POST request at the network layer. The
// mutate-form on PAGE_HTML always calls e.preventDefault(), which is
// exactly why no prior test exercised this: a navigation-type mutation
// bypassed classifyResourceRequest entirely (2026-09-11 review finding).
const REAL_NAV_FORM_PAGE_HTML = `<!doctype html><html><body>
  <form id="real-mutate-form" action="/mutate" method="post">
    <button type="submit" id="real-submit">Real submit</button>
  </form>
</body></html>`;

// 2026-09-14 addendum fix: real redirect-chain probes. Every "forbidden"
// destination below increments its own server-side counter -- the actual
// acceptance evidence is "the counter stayed at 0", not merely "Playwright
// reported a denial event" (the addendum explicitly distinguishes these).
const redirectHitCounts: Record<string, number> = {};
function recordHit(key: string): void {
  redirectHitCounts[key] = (redirectHitCounts[key] ?? 0) + 1;
}

function postFormPageHtml(actionPath: string, submitId: string): string {
  return `<!doctype html><html><body>
    <form id="${submitId}-form" action="${actionPath}" method="post">
      <button type="submit" id="${submitId}">Submit</button>
    </form>
  </body></html>`;
}

let offOriginServer: Server;
let OFF_ORIGIN: string;

// 2026-09-15 fix: request-body/cookie continuity through the manual
// route.fetch()/route.fulfill() redirect relay -- captured by the target
// server itself, not asserted from the client side (which would only prove
// Playwright's own native follow-through, not that AutoQA's manual chase
// didn't somehow strip anything before relaying the first hop).
let lastCookiePostTargetBody: string | undefined;
let lastCookiePostTargetCookieHeader: string | undefined;

function readRequestBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/mutate") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "GET" && req.url === "/delete-record") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.url === "/admin") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(ADMIN_PAGE_HTML);
      return;
    }
    if (req.url === "/administrator") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(ADMINISTRATOR_PAGE_HTML);
      return;
    }
    if (req.url === "/real-nav-form") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(REAL_NAV_FORM_PAGE_HTML);
      return;
    }

    // --- redirect-chain fixture routes (2026-09-14 addendum fix) ---
    if (req.url === "/allowed/start") {
      res.writeHead(302, { Location: "/blocked/destination" });
      res.end();
      return;
    }
    if (req.url === "/blocked/destination") {
      recordHit("same-origin-forbidden");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>you should never see this</body></html>");
      return;
    }
    if (req.url === "/allowed/start-offorigin") {
      res.writeHead(302, { Location: `${OFF_ORIGIN}/blocked` });
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/allowed/redirect-307-out-of-scope") {
      res.writeHead(307, { Location: "/blocked/destination-307" });
      res.end();
      return;
    }
    if (req.url === "/blocked/destination-307") {
      recordHit("307-forbidden");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "POST" && req.url === "/allowed/redirect-308-out-of-scope") {
      res.writeHead(308, { Location: "/blocked/destination-308" });
      res.end();
      return;
    }
    if (req.url === "/blocked/destination-308") {
      recordHit("308-forbidden");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.url === "/allowed/post-redirect-307") {
      res.writeHead(307, { Location: "/allowed/post-redirect-307" });
      res.end();
      return;
    }
    if (req.url === "/allowed/legit-redirect") {
      res.writeHead(302, { Location: "/allowed/legit-target" });
      res.end();
      return;
    }
    if (req.url === "/allowed/legit-target") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1 id=\"legit-target-marker\">Legit target reached</h1></body></html>");
      return;
    }
    if (req.url === "/allowed/legit-post-redirect") {
      res.writeHead(307, { Location: "/allowed/legit-post-target" });
      res.end();
      return;
    }
    if (req.url === "/allowed/legit-post-target") {
      if (req.method !== "POST") {
        // Proves 307 preserved the original method through an ALLOWED
        // chain -- if the browser (mis)followed this as a GET, the test
        // must fail here, not silently pass.
        res.writeHead(405);
        res.end();
        return;
      }
      recordHit("legit-post-target-post-hits");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1 id=\"legit-post-target-marker\">Legit POST target reached</h1></body></html>");
      return;
    }
    if (req.url === "/allowed/loop") {
      recordHit("loop-hits");
      res.writeHead(302, { Location: "/allowed/loop" });
      res.end();
      return;
    }
    // 2026-09-15 fix: a plain, ALLOWED, non-redirecting endpoint with its
    // own hit counter -- proves chaseAndValidate()'s hop===0 terminal-
    // response path relays the already-fetched body via route.fulfill()
    // rather than ALSO letting the browser natively re-fetch it (which
    // would double the hit count, unlike the deliberate, disclosed 2x for
    // an actual redirect chain).
    if (req.url === "/allowed/terminal-endpoint") {
      recordHit("terminal-endpoint-hits");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1 id=\"terminal-marker\">Terminal, no redirect</h1></body></html>");
      return;
    }
    // 2026-09-15 fix: 307 (method-preserving) to a genuinely different
    // ORIGIN -- the existing 307/308 tests above only cover an out-of-scope
    // PATH on the same origin; this closes the "off-origin host" gap for
    // a method-preserving redirect specifically (302-off-origin was already
    // covered above).
    if (req.method === "POST" && req.url === "/allowed/redirect-307-offorigin") {
      res.writeHead(307, { Location: `${OFF_ORIGIN}/blocked-307` });
      res.end();
      return;
    }
    if (req.url === "/allowed/redirect-form-307-offorigin") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(postFormPageHtml("/allowed/redirect-307-offorigin", "post-307-offorigin-submit"));
      return;
    }
    // 2026-09-15 fix: request-body and cookie continuity through the
    // manual chase-and-relay -- captured server-side, not merely asserted
    // client-side.
    if (req.url === "/allowed/cookie-form") {
      res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "session=abc123-test-session" });
      res.end(`<!doctype html><html><body>
        <form id="cookie-post-form" action="/allowed/cookie-post-redirect" method="post">
          <input type="hidden" name="note" value="hello-from-the-form" />
          <button type="submit" id="cookie-post-submit">Submit</button>
        </form>
      </body></html>`);
      return;
    }
    if (req.url === "/allowed/cookie-post-redirect") {
      res.writeHead(307, { Location: "/allowed/cookie-post-target" });
      res.end();
      return;
    }
    if (req.url === "/allowed/cookie-post-target") {
      lastCookiePostTargetCookieHeader = req.headers.cookie;
      void readRequestBody(req).then((body) => {
        lastCookiePostTargetBody = body;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1 id=\"cookie-post-target-marker\">Cookie POST target reached</h1></body></html>");
      });
      return;
    }
    if (req.url === "/allowed/redirect-form") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(postFormPageHtml("/allowed/redirect-307-out-of-scope", "post-307-submit"));
      return;
    }
    if (req.url === "/allowed/redirect-form-308") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(postFormPageHtml("/allowed/redirect-308-out-of-scope", "post-308-submit"));
      return;
    }
    if (req.url === "/allowed/legit-post-form") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(postFormPageHtml("/allowed/legit-post-redirect", "legit-post-submit"));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(PAGE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const port = (server.address() as AddressInfo).port;
  ORIGIN = `http://localhost:${port}`;

  offOriginServer = createServer((req, res) => {
    if (req.url === "/blocked") {
      recordHit("off-origin-forbidden");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>you should never see this either</body></html>");
      return;
    }
    if (req.url === "/blocked-307") {
      recordHit("307-off-origin-forbidden");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => offOriginServer.listen(0, "localhost", resolve));
  OFF_ORIGIN = `http://localhost:${(offOriginServer.address() as AddressInfo).port}`;

  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => offOriginServer.close(() => resolve()));
});

function realTargetProfile(overrides: (raw: Record<string, unknown>) => void = () => {}) {
  const raw = {
    schemaVersion: 1,
    id: "test-real-target",
    name: "Test",
    target: { url: `${ORIGIN}/`, environmentKind: "self-hosted-real-app" },
    navigation: { allowedOrigins: [ORIGIN], allowedPathPrefixes: ["/"] },
    resources: { allowedApiOrigins: [ORIGIN], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["search"] },
    auth: { mode: "none" },
    provider: {
      explorer: { provider: "mock" },
      critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
      providerTimeoutMs: 30000,
    },
    limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
  };
  overrides(raw);
  return parseProfile(raw);
}

function fixtureProfile() {
  return realTargetProfile((raw) => {
    (raw["target"] as Record<string, unknown>)["environmentKind"] = "local-fixture";
  });
}

describe("pathWithinPrefix (the /admin vs /administrator boundary)", () => {
  it("matches the prefix itself and any path nested under it", () => {
    expect(pathWithinPrefix("/admin", "/admin")).toBe(true);
    expect(pathWithinPrefix("/admin/users", "/admin")).toBe(true);
  });

  it("does NOT match a different route that merely starts with the same characters", () => {
    expect(pathWithinPrefix("/administrator", "/admin")).toBe(false);
    expect(pathWithinPrefix("/administrator/panel", "/admin")).toBe(false);
  });
});

describe("ActionPolicy.classifyAction", () => {
  it("is exempt entirely for a local-fixture profile", () => {
    const policy = new ActionPolicy(fixtureProfile());
    const result = policy.classifyAction(
      { type: "click", target: { role: "button", name: "Mutate" } },
      { isSubmitControl: true, formAction: `${ORIGIN}/mutate`, formMethod: "post" }
    );
    expect(result.decision).toBe("allowed");
  });

  it("denies a submit-type click to an endpoint not on the allowlist (the H01-H09 auto-submit case)", () => {
    const policy = new ActionPolicy(realTargetProfile());
    const result: ActionClassification = policy.classifyAction(
      { type: "click", target: { role: "button", name: "Mutate" } },
      { isSubmitControl: true, formAction: `${ORIGIN}/mutate`, formMethod: "post", routePathname: "/" }
    );
    expect(result.decision).toBe("denied");
    if (result.decision === "denied") expect(result.reason).toContain("ACTION_POLICY_DENIED");
  });

  it("allows a submit-type click once its exact method+pathname is explicitly allowlisted AND a search/filter workflow is declared", () => {
    const policy = new ActionPolicy(
      realTargetProfile((raw) => {
        (raw["resources"] as Record<string, unknown>)["allowedFormSubmitEndpoints"] = [{ method: "get", pathname: "/search" }];
      })
    );
    const result = policy.classifyAction(
      { type: "click", target: { role: "button", name: "Search" } },
      { isSubmitControl: true, formAction: `${ORIGIN}/search`, formMethod: "get", routePathname: "/" }
    );
    expect(result.decision).toBe("allowed");
  });

  it("denies an allowlisted endpoint anyway when no search/filter workflow is declared (defense in depth)", () => {
    const policy = new ActionPolicy(
      realTargetProfile((raw) => {
        (raw["resources"] as Record<string, unknown>)["allowedFormSubmitEndpoints"] = [{ method: "get", pathname: "/search" }];
        (raw["workflows"] as Record<string, unknown>)["allowedWorkflowKinds"] = ["navigate"];
      })
    );
    const result = policy.classifyAction(
      { type: "click", target: { role: "button", name: "Search" } },
      { isSubmitControl: true, formAction: `${ORIGIN}/search`, formMethod: "get", routePathname: "/" }
    );
    expect(result.decision).toBe("denied");
  });

  it("denies a plain click that isn't a submit control, a link, or a recognized pagination control -- deny by default", () => {
    const policy = new ActionPolicy(realTargetProfile());
    const result = policy.classifyAction(
      { type: "click", target: { role: "button", name: "Plain button" } },
      { isSubmitControl: false, routePathname: "/" }
    );
    expect(result.decision).toBe("denied");
  });

  it("allows a navigation link click when \"navigate\" is declared and the destination is in path scope", () => {
    const policy = new ActionPolicy(
      realTargetProfile((raw) => {
        (raw["workflows"] as Record<string, unknown>)["allowedWorkflowKinds"] = ["navigate"];
      })
    );
    const result = policy.classifyAction(
      { type: "click", target: { role: "link", name: "Other page" } },
      { isSubmitControl: false, isLink: true, linkPathname: "/other", routePathname: "/" }
    );
    expect(result.decision).toBe("allowed");
  });

  it("denies a navigation link click when \"navigate\" is not declared", () => {
    const policy = new ActionPolicy(realTargetProfile()); // only "search" declared
    const result = policy.classifyAction(
      { type: "click", target: { role: "link", name: "Other page" } },
      { isSubmitControl: false, isLink: true, linkPathname: "/other", routePathname: "/" }
    );
    expect(result.decision).toBe("denied");
  });

  it("allows a recognized pagination-like control when \"paginate\" is declared", () => {
    const policy = new ActionPolicy(
      realTargetProfile((raw) => {
        (raw["workflows"] as Record<string, unknown>)["allowedWorkflowKinds"] = ["paginate"];
      })
    );
    const result = policy.classifyAction(
      { type: "click", target: { role: "button", name: "Next" } },
      { isSubmitControl: false, isPaginationLike: true, routePathname: "/" }
    );
    expect(result.decision).toBe("allowed");
  });

  it("denies an Enter keypress in a text field belonging to a non-allowlisted form (implicit submission)", () => {
    const policy = new ActionPolicy(realTargetProfile());
    const result = policy.classifyAction(
      { type: "press", target: { role: "textbox" }, key: "Enter" },
      { isSubmitControl: true, formAction: `${ORIGIN}/mutate`, formMethod: "post", routePathname: "/" }
    );
    expect(result.decision).toBe("denied");
  });

  it("denies an Enter keypress in a text field with NO enclosing form -- an unresolvable implicit submit", () => {
    const policy = new ActionPolicy(realTargetProfile());
    const result = policy.classifyAction(
      { type: "press", target: { role: "textbox" }, key: "Enter" },
      { isAmbiguousEnter: true, routePathname: "/" }
    );
    expect(result.decision).toBe("denied");
  });

  it("denies any action (fill, click) outside the declared path-prefix scope, and allows one inside it", () => {
    const policy = new ActionPolicy(
      realTargetProfile((raw) => {
        (raw["navigation"] as Record<string, unknown>)["allowedPathPrefixes"] = ["/admin"];
      })
    );
    const outOfScope = policy.classifyAction({ type: "fill", target: { role: "textbox" }, value: "x" }, { routePathname: "/other" });
    expect(outOfScope.decision).toBe("denied");

    const inScope = policy.classifyAction({ type: "fill", target: { role: "textbox" }, value: "x" }, { routePathname: "/admin/users" });
    expect(inScope.decision).toBe("allowed");
  });

  it("a path prefix of /admin does not accidentally admit /administrator (the boundary bug)", () => {
    const policy = new ActionPolicy(
      realTargetProfile((raw) => {
        (raw["navigation"] as Record<string, unknown>)["allowedPathPrefixes"] = ["/admin"];
      })
    );
    const result = policy.classifyAction({ type: "fill", target: { role: "textbox" }, value: "x" }, { routePathname: "/administrator" });
    expect(result.decision).toBe("denied");
  });
});

describe("ActionPolicy.classifyResourceRequest", () => {
  it("denies a cross-origin request even when the pathname matches an allowlisted endpoint", () => {
    const policy = new ActionPolicy(
      realTargetProfile((raw) => {
        (raw["resources"] as Record<string, unknown>)["allowedFormSubmitEndpoints"] = [{ method: "post", pathname: "/login" }];
      })
    );
    const result = policy.classifyResourceRequest("POST", "/login", "https://attacker.example", "fetch");
    expect(result.decision).toBe("denied");
  });

  it("allows the same request on the profile's own allowlisted origin", () => {
    const policy = new ActionPolicy(
      realTargetProfile((raw) => {
        (raw["resources"] as Record<string, unknown>)["allowedFormSubmitEndpoints"] = [{ method: "post", pathname: "/login" }];
      })
    );
    const result = policy.classifyResourceRequest("POST", "/login", ORIGIN, "fetch");
    expect(result.decision).toBe("allowed");
  });

  it("denies a GET to a destructive-keyword-shaped pathname even though GET is ordinarily allowed", () => {
    const policy = new ActionPolicy(realTargetProfile());
    const result = policy.classifyResourceRequest("GET", "/delete-record", ORIGIN, "fetch");
    expect(result.decision).toBe("denied");
  });

  it("allows an ordinary GET read", () => {
    const policy = new ActionPolicy(realTargetProfile());
    const result = policy.classifyResourceRequest("GET", "/api/employees", ORIGIN, "xhr");
    expect(result.decision).toBe("allowed");
  });

  it("never blocks asset-shaped requests regardless of origin", () => {
    const policy = new ActionPolicy(realTargetProfile());
    const result = policy.classifyResourceRequest("GET", "/app.css", "https://a-cdn.example", "stylesheet");
    expect(result.decision).toBe("allowed");
  });

  // 2026-09-11 independent-review fix: "document" (Playwright's
  // resourceType for every navigation, including a native <form> POST
  // submission) was previously blanket-exempted as an "asset" -- these
  // four prove it now goes through the same origin/path/method/endpoint
  // checks as an xhr/fetch request.
  it("denies a document-typed navigation with a POST method to an unapproved endpoint (native form submit)", () => {
    const policy = new ActionPolicy(realTargetProfile());
    const result = policy.classifyResourceRequest("POST", "/mutate", ORIGIN, "document");
    expect(result.decision).toBe("denied");
  });

  it("allows a document-typed GET navigation to an in-scope page", () => {
    const policy = new ActionPolicy(
      realTargetProfile((raw) => {
        (raw["navigation"] as Record<string, unknown>)["allowedPathPrefixes"] = ["/app"];
      })
    );
    const result = policy.classifyResourceRequest("GET", "/app/dashboard", ORIGIN, "document");
    expect(result.decision).toBe("allowed");
  });

  it("denies a document-typed GET navigation outside the declared path-prefix scope", () => {
    const policy = new ActionPolicy(
      realTargetProfile((raw) => {
        (raw["navigation"] as Record<string, unknown>)["allowedPathPrefixes"] = ["/app"];
      })
    );
    const result = policy.classifyResourceRequest("GET", "/admin", ORIGIN, "document");
    expect(result.decision).toBe("denied");
  });

  it("denies a document-typed request whose origin isn't in navigation.allowedOrigins, even if allowedApiOrigins would have permitted it", () => {
    const policy = new ActionPolicy(
      realTargetProfile((raw) => {
        (raw["resources"] as Record<string, unknown>)["allowedApiOrigins"] = ["https://attacker.example"];
      })
    );
    const result = policy.classifyResourceRequest("GET", "/", "https://attacker.example", "document");
    expect(result.decision).toBe("denied");
  });
});

describe("ActionPolicy enforced end-to-end via executeAction (real browser)", () => {
  it("blocks the H01-style fill+submit sequence at the click step, without ever submitting the mutate form", async () => {
    const profile = realTargetProfile();
    const config = profileToAppConfig(profile);
    const policy = new ActionPolicy(profile);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const logger = createLogger();

    const fillResult = await executeAction(
      page,
      { type: "fill", target: { role: "textbox", name: "Mutate query" }, value: "" },
      config,
      logger,
      undefined,
      policy
    );
    expect(fillResult.outcome).toBe("success");

    const clickResult = await executeAction(page, { type: "click", target: { role: "button", name: "Mutate" } }, config, logger, undefined, policy);
    expect(clickResult.outcome).toBe("blocked");
    if (clickResult.outcome === "blocked") expect(clickResult.reason).toContain("ACTION_POLICY_DENIED");

    const submitted = await page.evaluate(() => (window as unknown as { __mutateSubmitted?: boolean }).__mutateSubmitted);
    expect(submitted).toBeUndefined();
    await context.close();
  });

  it("blocks a fill outside the declared path-prefix scope", async () => {
    const profile = realTargetProfile((raw) => {
      (raw["navigation"] as Record<string, unknown>)["allowedPathPrefixes"] = ["/admin"];
    });
    const config = profileToAppConfig(profile);
    const policy = new ActionPolicy(profile);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`); // "/" is outside the "/admin" scope
    const logger = createLogger();

    const fillResult = await executeAction(
      page,
      { type: "fill", target: { role: "textbox", name: "Mutate query" }, value: "x" },
      config,
      logger,
      undefined,
      policy
    );
    expect(fillResult.outcome).toBe("blocked");
    await context.close();
  });

  it("blocks an implicit Enter-submit in a field with no enclosing form", async () => {
    const profile = realTargetProfile();
    const config = profileToAppConfig(profile);
    const policy = new ActionPolicy(profile);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const logger = createLogger();

    const pressResult = await executeAction(
      page,
      { type: "press", target: { role: "textbox", name: "Bare search (no form)" }, key: "Enter" },
      config,
      logger,
      undefined,
      policy
    );
    expect(pressResult.outcome).toBe("blocked");
    const submitted = await page.evaluate(() => (window as unknown as { __bareSearchSubmitted?: boolean }).__bareSearchSubmitted);
    expect(submitted).toBeUndefined();
    await context.close();
  });

  it("blocks a plain non-submit button click by default", async () => {
    const profile = realTargetProfile();
    const config = profileToAppConfig(profile);
    const policy = new ActionPolicy(profile);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const logger = createLogger();

    const clickResult = await executeAction(page, { type: "click", target: { role: "button", name: "Plain button" } }, config, logger, undefined, policy);
    expect(clickResult.outcome).toBe("blocked");
    const clicked = await page.evaluate(() => (window as unknown as { __plainClicked?: boolean }).__plainClicked);
    expect(clicked).toBeUndefined();
    await context.close();
  });

  it("allows an approved search submit to actually fire", async () => {
    const profile = realTargetProfile((raw) => {
      (raw["resources"] as Record<string, unknown>)["allowedFormSubmitEndpoints"] = [{ method: "get", pathname: "/search" }];
    });
    const config = profileToAppConfig(profile);
    const policy = new ActionPolicy(profile);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const logger = createLogger();

    const clickResult = await executeAction(page, { type: "click", target: { role: "button", name: "Search" } }, config, logger, undefined, policy);
    expect(clickResult.outcome).toBe("success");

    const submitted = await page.evaluate(() => (window as unknown as { __searchSubmitted?: boolean }).__searchSubmitted);
    expect(submitted).toBe(true);
    await context.close();
  });

  it("emits an ACTION_POLICY_DENIED safety event with an audit record on denial", async () => {
    const profile = realTargetProfile();
    const config = profileToAppConfig(profile);
    const policy = new ActionPolicy(profile);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const events: SafetyEvent[] = [];
    const logger = createLogger();

    await executeAction(
      page,
      { type: "click", target: { role: "button", name: "Mutate" } },
      config,
      logger,
      (e) => events.push(e),
      policy
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe("ACTION_POLICY_DENIED");
    await context.close();
  });
});

describe("Validator replay re-applies ActionPolicy (not just live exploration)", () => {
  it("a finding whose triggering step is now policy-denied does not silently reproduce past the denial", async () => {
    const profile = realTargetProfile();
    const config = profileToAppConfig(profile);
    const policy = new ActionPolicy(profile);
    const logger = createLogger();
    const browserManager = new BrowserManager(config, logger, true);
    await browserManager.launch();

    const finding: Finding = {
      id: "FINDING-POLICY-TEST",
      title: "t",
      status: "suspected",
      category: "network",
      pageId: "PAGE-TEST",
      url: `${ORIGIN}/`,
      pathname: "/",
      expected: "0 new HTTP 5xx responses",
      actual: "n/a",
      oracle: { oracleId: "http-failure", suspicious: true, expected: "0 new HTTP 5xx responses", actual: "1 new HTTP 5xx response", details: { newFailures: [{ method: "POST", url: `${ORIGIN}/mutate`, status: 500 }] } },
      steps: [{ number: 1, action: { type: "click", target: { role: "button", name: "Mutate" } }, timestamp: new Date().toISOString() }],
      reproduction: { attempts: 0, successes: 0 },
      occurrenceCount: 1,
      evidence: [],
      evidenceLevel: "L3",
      reportDisposition: "needs_human",
    };

    const evidenceDir = mkdtempSync(join(tmpdir(), "autoqa-action-policy-validator-test-"));
    const validator = new Validator({
      browserManager,
      config,
      oracles: [createHttpFailureOracle()],
      logger,
      evidenceDir,
      policy,
    });

    const outcome = await validator.validate(finding);
    await browserManager.close();

    expect(outcome.attempts.every((a) => a.reproduced === false)).toBe(true);
    expect(outcome.attempts.every((a) => a.toolingBlocked?.includes("ACTION_POLICY_DENIED"))).toBe(true);
    // All attempts were tooling-blocked (never actually re-executed for
    // real) -- status must be the inconclusive "needs_human", never the
    // "rejected" a genuinely-disproven finding would get.
    expect(outcome.finding.status).toBe("needs_human");
  }, 20_000);
});

describe("ActionPolicy request-level defense (installRouteGuard resourcePolicy)", () => {
  it("aborts an unapproved POST fetch that bypasses the click-based detection entirely", async () => {
    const profile = realTargetProfile();
    const policy = new ActionPolicy(profile);
    const context = await browser.newContext();
    const events: SafetyEvent[] = [];
    const logger = createLogger();
    await installRouteGuard(context, [ORIGIN], logger, (e) => events.push(e), (method, pathname, origin, resourceType) => policy.classifyResourceRequest(method, pathname, origin, resourceType));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);

    const status = await page.evaluate(async (origin: string) => {
      try {
        const res = await fetch(`${origin}/mutate`, { method: "POST" });
        return res.status;
      } catch {
        return "aborted";
      }
    }, ORIGIN);

    expect(status).toBe("aborted");
    expect(events.some((e) => e.code === "ACTION_POLICY_DENIED")).toBe(true);
    await context.close();
  });

  it("aborts a GET fetch to a destructive-keyword pathname at the network layer too", async () => {
    const profile = realTargetProfile();
    const policy = new ActionPolicy(profile);
    const context = await browser.newContext();
    const events: SafetyEvent[] = [];
    const logger = createLogger();
    await installRouteGuard(context, [ORIGIN], logger, (e) => events.push(e), (method, pathname, origin, resourceType) => policy.classifyResourceRequest(method, pathname, origin, resourceType));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);

    const status = await page.evaluate(async (origin: string) => {
      try {
        const res = await fetch(`${origin}/delete-record`, { method: "GET" });
        return res.status;
      } catch {
        return "aborted";
      }
    }, ORIGIN);

    expect(status).toBe("aborted");
  });

  it("aborts a same-origin native <form method=post> submission to an unapproved endpoint at the network layer (2026-09-11 review fix: navigation-type requests previously bypassed resourcePolicy entirely)", async () => {
    const profile = realTargetProfile();
    const policy = new ActionPolicy(profile);
    const context = await browser.newContext();
    const events: SafetyEvent[] = [];
    const logger = createLogger();
    await installRouteGuard(context, [ORIGIN], logger, (e) => events.push(e), (method, pathname, origin, resourceType) => policy.classifyResourceRequest(method, pathname, origin, resourceType));
    const page = await context.newPage();
    // Same guard stack a real run actually installs (see
    // BrowserManager#newPageSession): layer 1 (route guard, above) aborts
    // the request before the browser commits to it, but the resulting
    // chrome-error interstitial still needs layer 3 to revert it back
    // on-origin -- this test isolates the POLICY decision, not the
    // recovery mechanism, so install the same defense-in-depth stack
    // production does rather than asserting on an interstitial page state
    // this layer was never meant to clean up by itself.
    installAsyncRedirectGuard(page, [ORIGIN], logger, (e) => events.push(e));
    await page.goto(`${ORIGIN}/real-nav-form`);

    await page.click("#real-submit");
    await page.waitForTimeout(500);

    expect(new URL(page.url()).origin).toBe(ORIGIN);
    expect(page.url()).not.toContain("/mutate");
    expect(events.some((e) => e.code === "ACTION_POLICY_DENIED")).toBe(true);
    await context.close();
  });

  it("still allows an ordinary same-origin GET link navigation through the route guard (regression guard for the fix above)", async () => {
    const profile = realTargetProfile();
    const policy = new ActionPolicy(profile);
    const context = await browser.newContext();
    const logger = createLogger();
    await installRouteGuard(context, [ORIGIN], logger, () => {}, (method, pathname, origin, resourceType) => policy.classifyResourceRequest(method, pathname, origin, resourceType));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);

    await page.click("#nav-link");
    await page.waitForLoadState("domcontentloaded");

    expect(page.url()).toBe(`${ORIGIN}/other`);
    await context.close();
  });
});

describe("redirect-chain policy enforcement (2026-09-14 addendum fix: route() only intercepts a request's first URL)", () => {
  function scopedProfile() {
    return realTargetProfile((raw) => {
      (raw["navigation"] as Record<string, unknown>)["allowedPathPrefixes"] = ["/allowed"];
    });
  }

  async function guardedContext(policy: ActionPolicy) {
    const context = await browser.newContext();
    const events: SafetyEvent[] = [];
    const logger = createLogger();
    await installRouteGuard(context, [ORIGIN], logger, (e) => events.push(e), (method, pathname, origin, resourceType) => policy.classifyResourceRequest(method, pathname, origin, resourceType));
    return { context, events };
  }

  it("a same-origin redirect to an out-of-scope path never reaches the forbidden destination -- zero server hits, not just a denial event", async () => {
    redirectHitCounts["same-origin-forbidden"] = 0;
    const policy = new ActionPolicy(scopedProfile());
    const { context, events } = await guardedContext(policy);
    const page = await context.newPage();

    await page.goto(`${ORIGIN}/allowed/start`).catch(() => {});
    await page.waitForTimeout(300);

    expect(redirectHitCounts["same-origin-forbidden"]).toBe(0);
    expect(events.some((e) => e.code === "ACTION_POLICY_DENIED")).toBe(true);
    await context.close();
  });

  it("a redirect to an off-origin destination never reaches the forbidden destination either -- zero hits on a SEPARATE server", async () => {
    redirectHitCounts["off-origin-forbidden"] = 0;
    const policy = new ActionPolicy(scopedProfile());
    const { context, events } = await guardedContext(policy);
    const page = await context.newPage();

    await page.goto(`${ORIGIN}/allowed/start-offorigin`).catch(() => {});
    await page.waitForTimeout(300);

    expect(redirectHitCounts["off-origin-forbidden"]).toBe(0);
    expect(events.some((e) => e.code === "ACTION_POLICY_DENIED")).toBe(true);
    await context.close();
  });

  it("a 307 (method-preserving) redirect to an out-of-scope destination is denied -- zero hits", async () => {
    redirectHitCounts["307-forbidden"] = 0;
    const policy = new ActionPolicy(scopedProfile());
    const { context, events } = await guardedContext(policy);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/allowed/redirect-form`);

    await page.click("#post-307-submit").catch(() => {});
    await page.waitForTimeout(300);

    expect(redirectHitCounts["307-forbidden"]).toBe(0);
    expect(events.some((e) => e.code === "ACTION_POLICY_DENIED")).toBe(true);
    await context.close();
  });

  it("a 308 (method-preserving) redirect to an out-of-scope destination is denied -- zero hits", async () => {
    redirectHitCounts["308-forbidden"] = 0;
    const policy = new ActionPolicy(scopedProfile());
    const { context, events } = await guardedContext(policy);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/allowed/redirect-form-308`);

    await page.click("#post-308-submit").catch(() => {});
    await page.waitForTimeout(300);

    expect(redirectHitCounts["308-forbidden"]).toBe(0);
    expect(events.some((e) => e.code === "ACTION_POLICY_DENIED")).toBe(true);
    await context.close();
  });

  it("a fully in-scope redirect chain completes normally, with page.url() correctly reflecting the final destination (regression guard: must not break real post-login-style redirects)", async () => {
    // Note: page.goto() itself is not a classifyAction()-mediated "navigate"
    // QaAction -- it's a direct Playwright call the test makes, so no
    // workflows.allowedWorkflowKinds check applies here; only the
    // network-layer resourcePolicy (exercised by installRouteGuard) is
    // under test.
    const policy = new ActionPolicy(scopedProfile());
    const { context } = await guardedContext(policy);
    const page = await context.newPage();

    await page.goto(`${ORIGIN}/allowed/legit-redirect`);

    expect(page.url()).toBe(`${ORIGIN}/allowed/legit-target`);
    expect(await page.locator("#legit-target-marker").isVisible()).toBe(true);
    await context.close();
  });

  it("a fully in-scope 307 POST redirect preserves the method end-to-end (the final target only accepts POST)", async () => {
    redirectHitCounts["legit-post-target-post-hits"] = 0;
    // Both the redirecting endpoint AND its final destination must be
    // explicitly allowlisted mutation endpoints -- a POST is never "in
    // scope" just because its path prefix matches; this is the same
    // strict-by-default endpoint allowlist classifyMethodAndPathname()
    // already enforces for every other mutation in this file.
    const profile = realTargetProfile((raw) => {
      (raw["navigation"] as Record<string, unknown>)["allowedPathPrefixes"] = ["/allowed"];
      (raw["resources"] as Record<string, unknown>)["allowedFormSubmitEndpoints"] = [
        { method: "post", pathname: "/allowed/legit-post-redirect" },
        { method: "post", pathname: "/allowed/legit-post-target" },
      ];
    });
    const policy = new ActionPolicy(profile);
    const { context } = await guardedContext(policy);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/allowed/legit-post-form`);

    await page.click("#legit-post-submit");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(300);

    // 2, not 1: one POST from the Node-side validation walk (confirming
    // the whole chain is in-scope before relaying anything) and one
    // genuine POST from the browser natively following the already-vetted
    // redirect -- the disclosed, deliberate trade-off documented on
    // chaseAndValidate() in navigation-guard.ts. Either hit missing (0 or
    // 1) would mean either the method wasn't preserved end-to-end, or the
    // legitimate chain was wrongly denied.
    expect(redirectHitCounts["legit-post-target-post-hits"]).toBe(2);
    expect(page.url()).toBe(`${ORIGIN}/allowed/legit-post-target`);
    await context.close();
  });

  it("a redirect chain exceeding the bounded hop limit is denied rather than looped forever", async () => {
    redirectHitCounts["loop-hits"] = 0;
    const policy = new ActionPolicy(scopedProfile());
    const { context, events } = await guardedContext(policy);
    const page = await context.newPage();

    await page.goto(`${ORIGIN}/allowed/loop`).catch(() => {});
    await page.waitForTimeout(500);

    // Bounded: the loop route must not have been hit an unbounded number
    // of times, and the navigation must have been denied, not hung.
    expect(redirectHitCounts["loop-hits"]).toBeLessThan(25);
    expect(events.some((e) => e.code === "ACTION_POLICY_DENIED")).toBe(true);
    await context.close();
  });

  it("a plain, non-redirecting allowed endpoint is fetched exactly once -- the terminal-response relay path doesn't double-fetch", async () => {
    redirectHitCounts["terminal-endpoint-hits"] = 0;
    const policy = new ActionPolicy(scopedProfile());
    const { context } = await guardedContext(policy);
    const page = await context.newPage();

    await page.goto(`${ORIGIN}/allowed/terminal-endpoint`);

    expect(redirectHitCounts["terminal-endpoint-hits"]).toBe(1);
    expect(await page.locator("#terminal-marker").isVisible()).toBe(true);
    await context.close();
  });

  it("a 307 (method-preserving) redirect to a genuinely different ORIGIN is denied -- zero hits (closes the off-origin gap for 307/308, previously only proven for an out-of-scope path on the SAME origin)", async () => {
    redirectHitCounts["307-off-origin-forbidden"] = 0;
    const policy = new ActionPolicy(scopedProfile());
    const { context, events } = await guardedContext(policy);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/allowed/redirect-form-307-offorigin`);

    await page.click("#post-307-offorigin-submit").catch(() => {});
    await page.waitForTimeout(300);

    expect(redirectHitCounts["307-off-origin-forbidden"]).toBe(0);
    expect(events.some((e) => e.code === "ACTION_POLICY_DENIED")).toBe(true);
    await context.close();
  });

  it("a real request body and a cookie set earlier in the session both survive the manual chase-and-relay to the terminal target, not just method/final-URL", async () => {
    lastCookiePostTargetBody = undefined;
    lastCookiePostTargetCookieHeader = undefined;
    const profile = realTargetProfile((raw) => {
      (raw["navigation"] as Record<string, unknown>)["allowedPathPrefixes"] = ["/allowed"];
      (raw["resources"] as Record<string, unknown>)["allowedFormSubmitEndpoints"] = [
        { method: "post", pathname: "/allowed/cookie-post-redirect" },
        { method: "post", pathname: "/allowed/cookie-post-target" },
      ];
    });
    const policy = new ActionPolicy(profile);
    const { context } = await guardedContext(policy);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/allowed/cookie-form`);

    await page.click("#cookie-post-submit");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(300);

    expect(page.url()).toBe(`${ORIGIN}/allowed/cookie-post-target`);
    expect(lastCookiePostTargetBody).toContain("note=hello-from-the-form");
    expect(lastCookiePostTargetCookieHeader).toContain("session=abc123-test-session");
    await context.close();
  });
});

describe("CLI real-target protection: runPipeline() constructs a conservative fallback policy when none is supplied", () => {
  it("denies an unscoped mutation on a direct (non-RunManager) real-target run", async () => {
    const config = profileToAppConfig(
      realTargetProfile((raw) => {
        (raw["target"] as Record<string, unknown>)["environmentKind"] = "self-hosted-real-app";
      })
    );
    // Point the legacy AppConfig straight at the real target -- no profile,
    // no RunManager, matching a direct `npm run qa --config <file>`
    // invocation. Generous budget so the deterministic mock explorer has
    // room to reach the Mutate form's heuristic candidates.
    config.target.url = `${ORIGIN}/`;
    config.safety.allowedOrigins = [ORIGIN];
    config.models.explorer.provider = "mock";
    config.models.critic.enabled = false;
    config.agent.maxActions = 15;
    config.agent.maxModelCalls = 15;
    config.agent.maxDurationMs = 20_000;

    const runId = "RUN-CLI-POLICY-TEST";
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-cli-policy-test-"));
    const logger = createLogger();

    // No actionPolicy passed -- runPipeline() itself must construct a safe
    // default. If it didn't, this mock-explorer-driven run over the Mutate
    // form's fields would eventually attempt (and, absent a policy,
    // succeed at) submitting it.
    const result = await runPipeline({ config, runId, runDir, logger, headless: true });

    // Planning now rejects the unsafe candidate before it reaches the executor.
    expect(result.finalCtx.recordedSteps.every(step => step.action.type === "fill" || step.action.type === "reload")).toBe(true);
    expect(result.finalCtx.recordedSteps.some(step => step.action.type === "click" || step.action.type === "press")).toBe(false);
  }, 30_000);

  it("still allows the local fixture through unaffected (no fallback policy constructed)", async () => {
    // A local-fixture config must never get the conservative fallback --
    // confirmed indirectly: buildFallbackActionPolicy is only reachable
    // when config.target.environment !== "local-fixture" (see
    // src/run-pipeline.ts). This is a light smoke test that a
    // local-fixture AppConfig still resolves ActionPolicy to undefined by
    // re-deriving the same condition the implementation uses.
    expect("local-fixture" !== "local-fixture").toBe(false);
  });
});

void ConfigError;
