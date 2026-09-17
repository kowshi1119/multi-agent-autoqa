import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../src/browser/browser.js";
import { createLogger } from "../src/logger.js";
import { createConsoleErrorOracle } from "../src/oracles/console-error.js";
import { createHttpFailureOracle } from "../src/oracles/http-failure.js";
import type { Oracle } from "../src/oracles.js";
import { parseProfile } from "../src/profiles/schema.js";
import { ActionPolicy } from "../src/safety/action-policy.js";
import { decideStatus, Validator } from "../src/validator.js";
import type { Finding, OracleResult } from "../src/types.js";
import { loadTestConfig } from "./helpers/test-config.js";

describe("decideStatus", () => {
  const minimumSuccesses = 2;

  it("validates when all attempts reproduce (3/3)", () => {
    expect(decideStatus(3, 3, minimumSuccesses)).toBe("validated");
  });

  it("validates when exactly the minimum reproduces (2/3)", () => {
    expect(decideStatus(2, 3, minimumSuccesses)).toBe("validated");
  });

  it("needs a human when below the minimum but above zero (1/3)", () => {
    expect(decideStatus(1, 3, minimumSuccesses)).toBe("needs_human");
  });

  it("rejects when nothing reproduces but attempts genuinely ran (0/3 valid)", () => {
    expect(decideStatus(0, 3, minimumSuccesses)).toBe("rejected");
  });

  it("needs a human -- never rejected -- when every attempt was tooling-blocked (0 valid attempts)", () => {
    expect(decideStatus(0, 0, minimumSuccesses)).toBe("needs_human");
  });

  it("excludes blocked attempts from both successes and the valid-attempt denominator: 1 blocked + 2 genuinely-not-reproduced still rejects", () => {
    // 3 total attempts, 1 blocked -> validAttempts=2, successes=0 among those 2.
    expect(decideStatus(0, 2, minimumSuccesses)).toBe("rejected");
  });

  it("excludes blocked attempts from the denominator when counting toward minimumSuccesses: 1 blocked + 2 reproduced still validates", () => {
    // 3 total attempts, 1 blocked -> validAttempts=2, successes=2 among those 2, meets minimumSuccesses=2.
    expect(decideStatus(2, 2, minimumSuccesses)).toBe("validated");
  });

  it("§7c fix (2026-09-14 addendum): needs a human, never rejected, when only 1 valid attempt ran but 2 are required -- a single genuine negative attempt is not enough evidence to confidently reject", () => {
    expect(decideStatus(0, 1, minimumSuccesses)).toBe("needs_human");
  });
});

// OS-assigned (port 0) rather than a fixed literal: the source and
// tsc-compiled copies of this file must never be able to collide on the
// same hardcoded port (see vitest.config.ts).
let ORIGIN: string;
const PAGE_HTML = `<!doctype html><html><body>
  <button>Trigger</button>
  <script>
    document.querySelector("button").addEventListener("click", function () {
      fetch("/api/fail", { method: "POST" });
    });
  </script>
</body></html>`;

// A client-state-dependent page for the prerequisite-prefix tests (§4b):
// the Trigger button's request only fails once "Apply Filter" has been
// clicked earlier in the SAME session -- a direct goto() to this page
// alone can never reproduce it; only replaying the filter step first can.
const FILTER_PAGE_HTML = `<!doctype html><html><body>
  <h1>List</h1>
  <button id="filter-btn">Apply Filter</button>
  <button id="trigger-btn">Trigger</button>
  <script>
    window.__filtered = false;
    document.getElementById("filter-btn").addEventListener("click", function () { window.__filtered = true; });
    document.getElementById("trigger-btn").addEventListener("click", function () {
      fetch(window.__filtered ? "/api/filtered-fail" : "/api/filtered-ok", { method: "POST" });
    });
  </script>
</body></html>`;

// §7a page (2026-09-14 addendum): the prerequisite click alone produces a
// console error matching what the "finding" was seeded with; the trigger
// click itself produces nothing new. Isolates whether the oracle's
// before/after window incorrectly includes prerequisite-caused noise.
const PREREQ_NOISE_PAGE_HTML = `<!doctype html><html><body>
  <button id="prereq-btn">Prereq</button>
  <button id="trigger-btn">Trigger</button>
  <script>
    document.getElementById("prereq-btn").addEventListener("click", function () {
      console.error("Prereq-only console error");
    });
    document.getElementById("trigger-btn").addEventListener("click", function () {});
  </script>
</body></html>`;

let server: Server;
let responseQueue: number[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/filter-page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(FILTER_PAGE_HTML);
      return;
    }
    if (req.method === "GET" && req.url === "/prereq-noise-page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PREREQ_NOISE_PAGE_HTML);
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE_HTML);
      return;
    }
    if (req.method === "POST" && req.url === "/api/fail") {
      const status = responseQueue.shift() ?? 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "POST" && (req.url === "/api/filtered-fail" || req.url === "/api/filtered-ok")) {
      res.writeHead(req.url === "/api/filtered-fail" ? 500 : 200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const port = (server.address() as AddressInfo).port;
  ORIGIN = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function testConfig() {
  return loadTestConfig((y) =>
    y
      .replace('url: "http://localhost:4173/"', `url: "${ORIGIN}/"`)
      .replace('- "http://localhost:4173"', `- "${ORIGIN}"`)
  );
}

function baseFinding(triggeringStatus: number): Finding {
  const oracle: OracleResult = {
    oracleId: "http-failure",
    suspicious: true,
    expected: "0 new HTTP 5xx responses",
    actual: "1 new HTTP 5xx response",
    details: { newFailures: [{ method: "POST", url: `${ORIGIN}/api/fail`, status: triggeringStatus }] },
  };
  return {
    id: "FINDING-TEST",
    title: "t",
    status: "suspected",
    category: "network",
    pageId: "PAGE-TEST",
    url: `${ORIGIN}/`,
    pathname: "/",
    expected: "e",
    actual: "a",
    oracle,
    steps: [{ number: 1, action: { type: "click", target: { role: "button", name: "Trigger" } }, timestamp: new Date().toISOString() }],
    reproduction: { attempts: 0, successes: 0 },
    occurrenceCount: 1,
    evidence: [],
    evidenceLevel: "L3",
    reportDisposition: "needs_human",
  };
}

function tempEvidenceDir(): string {
  return mkdtempSync(join(tmpdir(), "autoqa-validator-test-"));
}

describe("Validator.validate (real browser)", () => {
  let browserManager: BrowserManager;
  const oracles: Oracle[] = [createHttpFailureOracle()];

  beforeEach(async () => {
    responseQueue = [];
    browserManager = new BrowserManager(testConfig(), createLogger(), true);
    await browserManager.launch();
  });

  afterEach(async () => {
    await browserManager.close();
  });

  it("captures evidence from attempt 1 when it immediately reproduces (tracing invoked exactly once)", async () => {
    responseQueue = [500, 500, 500];
    const evidenceDir = tempEvidenceDir();
    const startTracingSpy = vi.spyOn(browserManager, "startTracing");
    const validator = new Validator({ browserManager, config: testConfig(), oracles, logger: createLogger(), evidenceDir });

    const outcome = await validator.validate(baseFinding(500));

    expect(outcome.finding.status).toBe("validated");
    expect(outcome.representativeAttempt).toBe(1);
    expect(outcome.evidenceCompleteness).toBe("representative-success");
    expect(startTracingSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(join(evidenceDir, "trace.zip"))).toBe(true);
    expect(existsSync(join(evidenceDir, "screenshot.png"))).toBe(true);
  });

  it("fail then pass then pass: representative attempt is the first success, tracing invoked exactly twice, exactly one trace.zip/screenshot.png persisted", async () => {
    responseQueue = [200, 500, 500];
    const evidenceDir = tempEvidenceDir();
    const startTracingSpy = vi.spyOn(browserManager, "startTracing");
    const validator = new Validator({ browserManager, config: testConfig(), oracles, logger: createLogger(), evidenceDir });

    const outcome = await validator.validate(baseFinding(500));

    expect(outcome.finding.status).toBe("validated");
    expect(outcome.attempts.map((a) => a.reproduced)).toEqual([false, true, true]);
    expect(outcome.representativeAttempt).toBe(2);
    expect(outcome.evidenceCompleteness).toBe("representative-success");
    expect(startTracingSpy).toHaveBeenCalledTimes(2);

    const files = readdirSync(evidenceDir);
    expect(files.filter((f) => f.endsWith(".zip"))).toEqual(["trace.zip"]);
    expect(files.filter((f) => f.endsWith(".png"))).toEqual(["screenshot.png"]);
  });

  it("a different failure from the same oracle (different status) does not count as reproducing the original finding", async () => {
    responseQueue = [503, 500, 500];
    const evidenceDir = tempEvidenceDir();
    const validator = new Validator({ browserManager, config: testConfig(), oracles, logger: createLogger(), evidenceDir });

    // Original finding was triggered by a 500; attempt 1 fires the oracle
    // (503 >= 500) but is a DIFFERENT failure signature.
    const outcome = await validator.validate(baseFinding(500));

    expect(outcome.attempts[0]?.oracleSuspicious).toBe(true);
    expect(outcome.attempts[0]?.reproduced).toBe(false);
    expect(outcome.attempts[1]?.reproduced).toBe(true);
    expect(outcome.finding.reproduction.successes).toBe(2);
    expect(outcome.representativeAttempt).toBe(2);
  });

  it("no attempt reproduces: evidence is labeled diagnostic-no-success from the LAST attempt, status is rejected", async () => {
    responseQueue = [200, 200, 200];
    const evidenceDir = tempEvidenceDir();
    const startTracingSpy = vi.spyOn(browserManager, "startTracing");
    const validator = new Validator({ browserManager, config: testConfig(), oracles, logger: createLogger(), evidenceDir });

    const outcome = await validator.validate(baseFinding(500));

    expect(outcome.finding.status).toBe("rejected");
    expect(outcome.attempts.every((a) => !a.reproduced)).toBe(true);
    expect(outcome.representativeAttempt).toBe(3);
    expect(outcome.evidenceCompleteness).toBe("diagnostic-no-success");
    expect(startTracingSpy).toHaveBeenCalledTimes(3);

    const files = readdirSync(evidenceDir);
    expect(files.filter((f) => f.endsWith(".zip"))).toEqual(["trace.zip"]);
    expect(files.filter((f) => f.endsWith(".png"))).toEqual(["screenshot.png"]);
  });

  it("every attempt tooling-blocked by ActionPolicy: status is needs_human, never rejected", async () => {
    responseQueue = [500, 500, 500];
    const evidenceDir = tempEvidenceDir();
    // A real-target profile with no declared scope denies the triggering
    // click by construction -- every replay attempt is toolingBlocked, so
    // the finding must never read as a genuinely-disproven "rejected".
    const profile = parseProfile({
      schemaVersion: 1,
      id: "deny-all",
      name: "deny-all",
      target: { url: `${ORIGIN}/`, environmentKind: "self-hosted-real-app" },
      navigation: { allowedOrigins: [ORIGIN], allowedPathPrefixes: [] },
      resources: { allowedApiOrigins: [], allowedFormSubmitEndpoints: [] },
      workflows: { allowedWorkflowKinds: [] },
      auth: { mode: "none" },
      provider: {
        explorer: { provider: "mock" },
        critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
        providerTimeoutMs: 30000,
      },
      limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
    });
    const policy = new ActionPolicy(profile);
    const validator = new Validator({ browserManager, config: testConfig(), oracles, logger: createLogger(), evidenceDir, policy });

    const outcome = await validator.validate(baseFinding(500));

    expect(outcome.attempts.every((a) => Boolean(a.toolingBlocked))).toBe(true);
    expect(outcome.attempts.every((a) => !a.reproduced)).toBe(true);
    expect(outcome.finding.status).toBe("needs_human");
  });
});

describe("Validator replay with Finding.prerequisitePrefix (Phase 4 continuation, §4b)", () => {
  let browserManager: BrowserManager;

  beforeEach(async () => {
    browserManager = new BrowserManager(testConfig(), createLogger(), true);
    await browserManager.launch();
  });

  afterEach(async () => {
    await browserManager.close();
  });

  function filterDependentFinding(prerequisitePrefix?: Finding["prerequisitePrefix"]): Finding {
    return {
      id: "FINDING-PREREQ-TEST",
      title: "t",
      status: "suspected",
      category: "network",
      pageId: "PAGE-FILTER",
      url: `${ORIGIN}/filter-page`,
      pathname: "/filter-page",
      expected: "0 new HTTP 5xx responses",
      actual: "1 new HTTP 5xx response",
      oracle: {
        oracleId: "http-failure",
        suspicious: true,
        expected: "0 new HTTP 5xx responses",
        actual: "1 new HTTP 5xx response",
        details: { newFailures: [{ method: "POST", url: `${ORIGIN}/api/filtered-fail`, status: 500 }] },
      },
      steps: [{ number: 2, action: { type: "click", target: { role: "button", name: "Trigger" } }, timestamp: new Date().toISOString() }],
      ...(prerequisitePrefix ? { prerequisitePrefix } : {}),
      reproduction: { attempts: 0, successes: 0 },
      occurrenceCount: 1,
      evidence: [],
      evidenceLevel: "L3",
      reportDisposition: "needs_human",
    };
  }

  const applyFilterStep: NonNullable<Finding["prerequisitePrefix"]>[number] = {
    number: 1,
    action: { type: "click", target: { role: "button", name: "Apply Filter" } },
    timestamp: new Date().toISOString(),
  };

  it("reproduces a filter-dependent finding only when the prerequisite filter step is replayed first", async () => {
    const evidenceDir = tempEvidenceDir();
    const validator = new Validator({ browserManager, config: testConfig(), oracles: [createHttpFailureOracle()], logger: createLogger(), evidenceDir });

    const outcome = await validator.validate(filterDependentFinding([applyFilterStep]));

    expect(outcome.attempts.every((a) => a.reproduced)).toBe(true);
    expect(outcome.finding.status).toBe("validated");
  });

  it("control: without the prerequisite prefix, the same triggering step alone never reproduces (a direct goto() doesn't restore client-side filter state)", async () => {
    const evidenceDir = tempEvidenceDir();
    const validator = new Validator({ browserManager, config: testConfig(), oracles: [createHttpFailureOracle()], logger: createLogger(), evidenceDir });

    const outcome = await validator.validate(filterDependentFinding(undefined));

    expect(outcome.attempts.every((a) => !a.reproduced)).toBe(true);
    expect(outcome.finding.status).toBe("rejected");
  });

  it("a prerequisite step that is now policy-denied is tooling-blocked -- needs_human, never a false rejection", async () => {
    const evidenceDir = tempEvidenceDir();
    // Scoped to a path prefix that excludes /filter-page entirely -- the
    // prerequisite's own click is denied before it ever runs, exactly as
    // a real profile's declared scope shrinking (or a genuinely revoked
    // permission) would deny it.
    const profile = parseProfile({
      schemaVersion: 1,
      id: "deny-filter-page",
      name: "deny-filter-page",
      target: { url: `${ORIGIN}/`, environmentKind: "self-hosted-real-app" },
      navigation: { allowedOrigins: [ORIGIN], allowedPathPrefixes: ["/other"] },
      resources: { allowedApiOrigins: [], allowedFormSubmitEndpoints: [] },
      workflows: { allowedWorkflowKinds: [] },
      auth: { mode: "none" },
      provider: {
        explorer: { provider: "mock" },
        critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
        providerTimeoutMs: 30000,
      },
      limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
    });
    const policy = new ActionPolicy(profile);
    const validator = new Validator({ browserManager, config: testConfig(), oracles: [createHttpFailureOracle()], logger: createLogger(), evidenceDir, policy });

    const outcome = await validator.validate(filterDependentFinding([applyFilterStep]));

    expect(outcome.attempts.every((a) => Boolean(a.toolingBlocked))).toBe(true);
    expect(outcome.attempts.every((a) => !a.reproduced)).toBe(true);
    expect(outcome.finding.status).toBe("needs_human");
  });
});

describe("Validator before/after boundary (2026-09-14 addendum §7a: `before` used to be captured BEFORE prerequisite replay, not after)", () => {
  let browserManager: BrowserManager;

  beforeEach(async () => {
    browserManager = new BrowserManager(testConfig(), createLogger(), true);
    await browserManager.launch();
  });

  afterEach(async () => {
    await browserManager.close();
  });

  it("a prerequisite step's own side effect (matching the oracle's seeded signature) is excluded from reproduction -- `before` is captured only once prerequisites have already run", async () => {
    const evidenceDir = tempEvidenceDir();
    const validator = new Validator({
      browserManager,
      config: testConfig(),
      oracles: [createConsoleErrorOracle(testConfig())],
      logger: createLogger(),
      evidenceDir,
    });

    const finding: Finding = {
      id: "FINDING-PREREQ-NOISE-TEST",
      title: "t",
      status: "suspected",
      category: "console",
      pageId: "PAGE-PREREQ-NOISE",
      url: `${ORIGIN}/prereq-noise-page`,
      pathname: "/prereq-noise-page",
      expected: "0 new unexpected error-level console messages",
      actual: "1 new unexpected error-level console message",
      oracle: {
        oracleId: "console-error",
        suspicious: true,
        expected: "0 new unexpected error-level console messages",
        actual: "1 new unexpected error-level console message",
        details: { newErrors: ["Prereq-only console error"] },
      },
      steps: [{ number: 2, action: { type: "click", target: { role: "button", name: "Trigger" } }, timestamp: new Date().toISOString() }],
      prerequisitePrefix: [
        { number: 1, action: { type: "click", target: { role: "button", name: "Prereq" } }, timestamp: new Date().toISOString() },
      ],
      reproduction: { attempts: 0, successes: 0 },
      occurrenceCount: 1,
      evidence: [],
      evidenceLevel: "L3",
      reportDisposition: "needs_human",
    };

    const outcome = await validator.validate(finding);

    // Were `before` still captured pre-prerequisite (the old behavior), the
    // prerequisite's console.error would show up as "new" in `after` and
    // this would incorrectly read as reproduced/validated.
    expect(outcome.attempts.every((a) => !a.reproduced)).toBe(true);
    expect(outcome.attempts.every((a) => !a.oracleSuspicious)).toBe(true);
    expect(outcome.finding.status).toBe("rejected");
  });
});

describe("Validator replay cancellation bound (2026-09-15 fix: Stop is now checked between individual replay steps, not just between whole attempts)", () => {
  let browserManager: BrowserManager;

  beforeEach(async () => {
    browserManager = new BrowserManager(testConfig(), createLogger(), true);
    await browserManager.launch();
  });

  afterEach(async () => {
    await browserManager.close();
  });

  const applyFilterStep: NonNullable<Finding["prerequisitePrefix"]>[number] = {
    number: 1,
    action: { type: "click", target: { role: "button", name: "Apply Filter" } },
    timestamp: new Date().toISOString(),
  };

  function filterDependentFinding(prerequisitePrefix?: Finding["prerequisitePrefix"]): Finding {
    return {
      id: "FINDING-PREREQ-CANCEL-TEST",
      title: "t",
      status: "suspected",
      category: "network",
      pageId: "PAGE-FILTER",
      url: `${ORIGIN}/filter-page`,
      pathname: "/filter-page",
      expected: "0 new HTTP 5xx responses",
      actual: "1 new HTTP 5xx response",
      oracle: {
        oracleId: "http-failure",
        suspicious: true,
        expected: "0 new HTTP 5xx responses",
        actual: "1 new HTTP 5xx response",
        details: { newFailures: [{ method: "POST", url: `${ORIGIN}/api/filtered-fail`, status: 500 }] },
      },
      steps: [{ number: 2, action: { type: "click", target: { role: "button", name: "Trigger" } }, timestamp: new Date().toISOString() }],
      ...(prerequisitePrefix ? { prerequisitePrefix } : {}),
      reproduction: { attempts: 0, successes: 0 },
      occurrenceCount: 1,
      evidence: [],
      evidenceLevel: "L3",
      reportDisposition: "needs_human",
    };
  }

  it("Stop fired right after the prerequisite step completes halts before the trigger step ever runs, wall-clock measured", async () => {
    const evidenceDir = tempEvidenceDir();
    const controller = new AbortController();

    // Playwright constructs a fresh Locator instance per call -- there is no
    // importable class to spy on directly. Grab a real instance's own
    // prototype first (shared by every Locator any page in this test
    // process creates), mirroring the same idiom already used for
    // BrowserContext/Locator spying elsewhere in this suite.
    const probeSession = await browserManager.newPageSession();
    const locatorProto = Object.getPrototypeOf(probeSession.page.locator("body")) as { click: (...args: unknown[]) => Promise<void> };
    await browserManager.closeSession(probeSession);

    let clickCount = 0;
    const realClick = locatorProto.click;
    const clickSpy = vi.spyOn(locatorProto, "click").mockImplementation(async function (this: unknown, ...args: unknown[]) {
      clickCount += 1;
      const result = await realClick.apply(this, args);
      if (clickCount === 1) controller.abort(); // right after the prerequisite's own click resolves
      return result;
    });

    const validator = new Validator({
      browserManager,
      config: testConfig(),
      oracles: [createHttpFailureOracle()],
      logger: createLogger(),
      evidenceDir,
      abortSignal: controller.signal,
    });

    const startedAt = Date.now();
    const outcome = await validator.validate(filterDependentFinding([applyFilterStep]));
    const elapsedMs = Date.now() - startedAt;

    // Exactly one click happened (the prerequisite's) -- the trigger step's
    // own click never fired, proving cancellation was checked BETWEEN the
    // two steps, not only between whole attempts.
    expect(clickCount).toBe(1);
    expect(outcome.attempts.length).toBe(1);
    expect(outcome.attempts[0]?.toolingBlocked).toContain("CANCELLED");
    expect(outcome.finding.status).toBe("needs_human");
    // Well under a single step's own LOCATOR_TIMEOUT_MS-scale bound -- the
    // old between-whole-attempts-only check could have let a second and
    // third full attempt (each with its own multi-step replay) run first.
    expect(elapsedMs).toBeLessThan(10_000);

    clickSpy.mockRestore();
  }, 30_000);

  it("2026-09-16 fix: Stop fired WHILE a triggering step's own locator-wait is already in flight interrupts it directly, not just between steps -- reproduces the real-Chromium probe's scenario for the replay path", async () => {
    const evidenceDir = tempEvidenceDir();
    const controller = new AbortController();

    const findingWithUnresolvableTrigger: Finding = {
      ...filterDependentFinding(),
      steps: [{ number: 1, action: { type: "click", target: { role: "button", name: "This Button Does Not Exist" } }, timestamp: new Date().toISOString() }],
    };

    const validator = new Validator({
      browserManager,
      config: testConfig(),
      oracles: [createHttpFailureOracle()],
      logger: createLogger(),
      evidenceDir,
      abortSignal: controller.signal,
    });

    // The target locator never resolves (no such button exists on the
    // page), so executeAction()'s own `waitFor({ state: "visible" })` is
    // genuinely in flight -- not merely about to start -- when abort fires.
    setTimeout(() => controller.abort(), 500);

    const startedAt = Date.now();
    const outcome = await validator.validate(findingWithUnresolvableTrigger);
    const elapsedMs = Date.now() - startedAt;

    expect(outcome.attempts[0]?.toolingBlocked).toContain("CANCELLED");
    // Genuinely interrupted, not bounded by LOCATOR_TIMEOUT_MS (5s) --
    // proves the fix reaches all the way through Validator's own replay
    // loop into executeAction()'s underlying Playwright call.
    expect(elapsedMs).toBeLessThan(3_000);
  }, 30_000);
});
