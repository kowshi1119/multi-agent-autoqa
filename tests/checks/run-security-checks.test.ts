import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSecurityChecks } from "../../src/checks/run-security-checks.js";
import { loadCheckLedger } from "../../src/checks/evidence.js";
import type { DeclaredSecurityCheck } from "../../src/checks/checks-manifest.js";
import { parseProfile } from "../../src/profiles/schema.js";
import type { ProjectProfile } from "../../src/profiles/schema.js";

let server: Server;
let ORIGIN: string;
const PLANTED_TOKEN = "leaked-secret-token-DO-NOT-USE-77123";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/good-cookie") {
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "session=abc; HttpOnly; Secure; SameSite=Strict" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/weak-cookie") {
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "session=abc; Path=/" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/all-headers") {
      res.writeHead(200, { "Content-Type": "application/json", "content-security-policy": "default-src 'self'", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "strict-transport-security": "max-age=63072000" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/no-headers") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/leaky") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", debugToken: PLANTED_TOKEN }));
      return;
    }
    if (req.url === "/clean") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/login-demo") {
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "session=demo-a-token; Path=/" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/api/account/demo-b/resource") {
      // Deliberately vulnerable: any session cookie is accepted for any account.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ resourceOwner: "demo-a", secretNote: "private note" }));
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

function baseProfile(): ProjectProfile {
  return parseProfile({
    schemaVersion: 1,
    id: "security-checks-test",
    name: "Test",
    target: { url: `${ORIGIN}/`, environmentKind: "owned-sandbox" },
    navigation: { allowedOrigins: [ORIGIN], allowedPathPrefixes: ["/"] },
    resources: { allowedApiOrigins: [ORIGIN], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"] },
    auth: { mode: "none" },
    provider: { explorer: { provider: "mock" }, critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 30000 },
    limits: { maxActions: 25, maxModelCalls: 20, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
    securityChecks: { enabled: true },
  });
}

describe("runSecurityChecks", () => {
  it("classifies a fully-attributed cookie as passed, with no Finding", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-sec-cookie-pass-"));
    const check: DeclaredSecurityCheck = { id: "COOKIE-001", kind: "cookie-attributes", pathname: "/good-cookie", description: "cookie attrs" };
    const { findings } = await runSecurityChecks(baseProfile(), [check], runDir, 1, ORIGIN);
    expect(findings).toHaveLength(0);
    expect(loadCheckLedger(runDir).entries[0]?.classification).toBe("passed");
  });

  it("classifies a cookie missing HttpOnly/Secure/SameSite as needs_review, not an auto-high-severity confirmed finding", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-sec-cookie-weak-"));
    const check: DeclaredSecurityCheck = { id: "COOKIE-002", kind: "cookie-attributes", pathname: "/weak-cookie", description: "cookie attrs" };
    const { findings } = await runSecurityChecks(baseProfile(), [check], runDir, 1, ORIGIN);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reportDisposition).toBe("needs_human");
    expect(findings[0]?.category).toBe("security");
    expect(loadCheckLedger(runDir).entries[0]?.classification).toBe("needs_review");
  });

  it("classifies missing security headers as needs_review with explicit context, not auto-confirmed", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-sec-headers-missing-"));
    const check: DeclaredSecurityCheck = { id: "HEADERS-001", kind: "security-headers", pathname: "/no-headers", description: "security headers" };
    const { findings } = await runSecurityChecks(baseProfile(), [check], runDir, 1, ORIGIN);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reportDisposition).toBe("needs_human");
    expect((findings[0]?.oracle.details as { impact: string }).impact).toContain("not proof of an exploitable vulnerability");
  });

  it("passes when all checked security headers are present", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-sec-headers-present-"));
    const check: DeclaredSecurityCheck = { id: "HEADERS-002", kind: "security-headers", pathname: "/all-headers", description: "security headers" };
    const { findings } = await runSecurityChecks(baseProfile(), [check], runDir, 1, ORIGIN);
    expect(findings).toHaveLength(0);
  });

  it("confirms a planted secret-shaped value in the response body, redacted in the observation", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-sec-leak-"));
    const check: DeclaredSecurityCheck = { id: "LEAK-001", kind: "secret-leakage", pathname: "/leaky", description: "secret leakage" };
    const { findings } = await runSecurityChecks(baseProfile(), [check], runDir, 1, ORIGIN);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reportDisposition).toBe("report");
    const entry = loadCheckLedger(runDir).entries[0];
    expect(entry?.classification).toBe("confirmed");
    expect(entry?.observation).not.toContain(PLANTED_TOKEN);
  });

  it("passes a clean response body with no secret-shaped pattern", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-sec-clean-"));
    const check: DeclaredSecurityCheck = { id: "LEAK-002", kind: "secret-leakage", pathname: "/clean", description: "secret leakage" };
    const { findings } = await runSecurityChecks(baseProfile(), [check], runDir, 1, ORIGIN);
    expect(findings).toHaveLength(0);
  });

  it("detects cross-account access via the two seeded demo accounts on the session-boundary check", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-sec-session-boundary-"));
    const check: DeclaredSecurityCheck = {
      id: "SESSION-001", kind: "session-boundary", pathname: "/", description: "cross-account boundary",
      sessionBoundary: { loginPathname: "/api/login-demo", accountAId: "demo-a", accountBId: "demo-b", resourcePathnameTemplate: "/api/account/{accountId}/resource" },
    };
    const { findings } = await runSecurityChecks(baseProfile(), [check], runDir, 1, ORIGIN);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reportDisposition).toBe("report");
    expect(findings[0]?.evidenceLevel).toBe("L1");
  });

  it("blocks a check whose pathname is outside navigation.allowedPathPrefixes, with a ledger entry and no Finding", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-sec-blocked-"));
    const profile = baseProfile();
    profile.navigation.allowedPathPrefixes = ["/only-this"];
    const check: DeclaredSecurityCheck = { id: "OUT-OF-SCOPE", kind: "cookie-attributes", pathname: "/good-cookie", description: "out of scope" };
    const { findings } = await runSecurityChecks(profile, [check], runDir, 1, ORIGIN);
    expect(findings).toHaveLength(0);
    const entry = loadCheckLedger(runDir).entries[0];
    expect(entry?.ran).toBe(false);
    expect(entry?.blockedReason).toContain("allowedPathPrefixes");
  });
});
