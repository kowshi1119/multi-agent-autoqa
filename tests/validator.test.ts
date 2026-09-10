import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../src/browser/browser.js";
import { createLogger } from "../src/logger.js";
import { createHttpFailureOracle } from "../src/oracles/http-failure.js";
import type { Oracle } from "../src/oracles.js";
import { decideStatus, Validator } from "../src/validator.js";
import type { Finding, OracleResult } from "../src/types.js";
import { loadTestConfig } from "./helpers/test-config.js";

describe("decideStatus", () => {
  const minimumSuccesses = 2;

  it("validates when all attempts reproduce (3/3)", () => {
    expect(decideStatus(3, minimumSuccesses)).toBe("validated");
  });

  it("validates when exactly the minimum reproduces (2/3)", () => {
    expect(decideStatus(2, minimumSuccesses)).toBe("validated");
  });

  it("needs a human when below the minimum but above zero (1/3)", () => {
    expect(decideStatus(1, minimumSuccesses)).toBe("needs_human");
  });

  it("rejects when nothing reproduces (0/3)", () => {
    expect(decideStatus(0, minimumSuccesses)).toBe("rejected");
  });
});

const PORT = 4196;
const ORIGIN = `http://localhost:${PORT}`;
const PAGE_HTML = `<!doctype html><html><body>
  <button>Trigger</button>
  <script>
    document.querySelector("button").addEventListener("click", function () {
      fetch("/api/fail", { method: "POST" });
    });
  </script>
</body></html>`;

let server: Server;
let responseQueue: number[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
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
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(PORT, "localhost", resolve));
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
});
