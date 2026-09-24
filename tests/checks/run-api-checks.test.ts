import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runApiChecks } from "../../src/checks/run-api-checks.js";
import { loadCheckLedger } from "../../src/checks/evidence.js";
import type { DeclaredApiCheck } from "../../src/checks/checks-manifest.js";
import { parseProfile } from "../../src/profiles/schema.js";
import type { ProjectProfile } from "../../src/profiles/schema.js";

let server: Server;
let ORIGIN: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/users/1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 1, email: "user@example.invalid", role: "member" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/users/broken") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 2 })); // missing "email"/"role"
      return;
    }
    if (req.method === "POST" && req.url === "/api/users/1/delete") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  ORIGIN = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function baseProfile(overrides: Partial<ProjectProfile["apiChecks"]> = {}, maxApiRequests?: number): ProjectProfile {
  return parseProfile({
    schemaVersion: 1,
    id: "api-checks-test",
    name: "Test",
    target: { url: `${ORIGIN}/`, environmentKind: "owned-sandbox" },
    navigation: { allowedOrigins: [ORIGIN], allowedPathPrefixes: ["/"] },
    resources: { allowedApiOrigins: [ORIGIN], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"] },
    auth: { mode: "none" },
    provider: { explorer: { provider: "mock" }, critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 30000 },
    limits: { maxActions: 25, maxModelCalls: 20, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5, ...(maxApiRequests !== undefined ? { maxApiRequests } : {}) },
    apiChecks: { enabled: true, allowedMutatingEndpoints: [], responseSizeCapBytes: 262144, ...overrides },
  });
}

describe("runApiChecks", () => {
  it("passes a check whose assertions are satisfied and records it as 'passed' with no Finding", async () => {
    const profile = baseProfile();
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-api-check-pass-"));
    const check: DeclaredApiCheck = {
      id: "USERS-001", method: "GET", pathname: "/api/users/1", description: "user 1 has required fields",
      assertions: { expectedStatus: 200, expectedContentType: "application/json", requiredFields: ["id", "email", "role"], invariants: [] },
    };
    const { findings } = await runApiChecks(profile, [check], runDir, 1, ORIGIN);
    expect(findings).toHaveLength(0);
    const ledger = loadCheckLedger(runDir);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.classification).toBe("passed");
    expect(ledger.entries[0]?.ran).toBe(true);
  });

  it("records a reproduced assertion mismatch as confirmed, but routes it to human review rather than reporting it as a product defect", async () => {
    const profile = baseProfile();
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-api-check-fail-"));
    const check: DeclaredApiCheck = {
      id: "USERS-002", method: "GET", pathname: "/api/users/broken", description: "user has required fields",
      assertions: { requiredFields: ["id", "email", "role"], invariants: [] },
    };
    const { findings } = await runApiChecks(profile, [check], runDir, 1, ORIGIN);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe("api");
    // A declared expectation can itself be wrong, so a reproduced mismatch
    // is never auto-reported as a defect.
    expect(findings[0]?.reportDisposition).toBe("needs_human");
    expect(findings[0]?.title).toContain("assertion mismatch (reproduced)");
    expect(findings[0]?.oracle.oracleId).toBe("declared-api-check");

    const ledger = loadCheckLedger(runDir);
    expect(ledger.entries[0]?.classification).toBe("confirmed");
    expect(ledger.entries[0]?.session).toBe("anonymous");
    expect(ledger.entries[0]?.findingId).toBe(findings[0]?.id);
  });

  it("blocks a mutating check with no allowedMutatingEndpoints entry, writes a ledger entry, and creates no Finding", async () => {
    const profile = baseProfile({ allowedMutatingEndpoints: [] });
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-api-check-blocked-"));
    const check: DeclaredApiCheck = {
      id: "USERS-003", method: "POST", pathname: "/api/users/1/delete", description: "should never run without authorization",
      assertions: { invariants: [] },
    };
    const { findings } = await runApiChecks(profile, [check], runDir, 1, ORIGIN);
    expect(findings).toHaveLength(0);
    const ledger = loadCheckLedger(runDir);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.ran).toBe(false);
    expect(ledger.entries[0]?.blockedReason).toContain("allowedMutatingEndpoints");
  });

  it("runs a mutating check once explicitly authorized", async () => {
    const profile = baseProfile({ allowedMutatingEndpoints: [{ method: "POST", pathname: "/api/users/1/delete" }] });
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-api-check-authorized-"));
    const check: DeclaredApiCheck = {
      id: "USERS-004", method: "POST", pathname: "/api/users/1/delete", description: "authorized mutating check",
      assertions: { expectedStatus: 200, invariants: [] },
    };
    const { findings } = await runApiChecks(profile, [check], runDir, 1, ORIGIN);
    expect(findings).toHaveLength(0);
    const ledger = loadCheckLedger(runDir);
    expect(ledger.entries[0]?.ran).toBe(true);
    expect(ledger.entries[0]?.classification).toBe("passed");
  });

  it("exhausts the request budget (maxApiRequests) and blocks remaining checks with a ledger entry each", async () => {
    const profile = baseProfile({}, 1);
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-api-check-budget-"));
    const checks: DeclaredApiCheck[] = [
      { id: "BUDGET-001", method: "GET", pathname: "/api/users/1", description: "first", assertions: { expectedStatus: 200, invariants: [] } },
      { id: "BUDGET-002", method: "GET", pathname: "/api/users/1", description: "second, should be blocked", assertions: { expectedStatus: 200, invariants: [] } },
    ];
    await runApiChecks(profile, checks, runDir, 1, ORIGIN);
    const ledger = loadCheckLedger(runDir);
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries[0]?.ran).toBe(true);
    expect(ledger.entries[1]?.ran).toBe(false);
    expect(ledger.entries[1]?.blockedReason).toContain("budget exhausted");
  });

  it("writes redacted request/response evidence for a failing check, reachable on disk", async () => {
    const profile = baseProfile();
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-api-check-evidence-"));
    const check: DeclaredApiCheck = {
      id: "USERS-EVIDENCE", method: "GET", pathname: "/api/users/broken", description: "evidence check",
      assertions: { requiredFields: ["email"], invariants: [] },
    };
    const { findings } = await runApiChecks(profile, [check], runDir, 1, ORIGIN);
    // Finding.evidence holds bare filenames resolved relative to
    // findings/<id>/ -- the same convention every other finding in the
    // codebase uses (and what index.html's evidence-link renderer assumes).
    for (const ref of findings[0]?.evidence ?? []) {
      const filePath = join(runDir, "findings", findings[0]!.id, ref);
      expect(existsSync(filePath)).toBe(true);
      expect(() => JSON.parse(readFileSync(filePath, "utf-8"))).not.toThrow();
    }

    const ledger = loadCheckLedger(runDir);
    expect(ledger.entries[0]?.evidenceRefs[0]).toMatch(/^findings\/FINDING-\d+\/request\.json$/);
  });
});
