import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProfile } from "../../src/profiles/schema.js";
import { fireCheckRequest } from "../../src/checks/http-client.js";
import { runApiChecks } from "../../src/checks/run-api-checks.js";
import { runSecurityChecks } from "../../src/checks/run-security-checks.js";
import { loadCheckLedger } from "../../src/checks/evidence.js";
import { checkBudget } from "../../src/checks/request-scope.js";
import { evaluateAssertions } from "../../src/checks/shape-check.js";
import { redactStructuredEvidence } from "../../src/checks/redact-structured.js";

afterEach(() => vi.restoreAllMocks());
const profile = () => parseProfile(JSON.parse(readFileSync("profiles/checks-demo.json", "utf8")));
const dir = () => mkdtempSync(join(tmpdir(), "checks-bounds-"));
const api = (pathname = "/api/broken") => ({ id: "test", method: "GET" as const, pathname, description: "status assertion", assertions: { expectedStatus: 200, invariants: [] } });

it("does not confirm a failure when the reproduction request fails", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 500 })).mockRejectedValueOnce(new Error("offline"));
  const result = await runApiChecks(profile(), [api()], dir(), 1, "http://localhost:4173");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result.findings[0]?.reportDisposition).toBe("needs_human");
  expect(result.findings[0]?.reproduction?.successes).toBe(1);
});

it("counts reproduction against the request limit", async () => {
  const p = profile(); p.limits.maxApiRequests = 1;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 500 }));
  const result = await runApiChecks(p, [api()], dir(), 1, "http://localhost:4173");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.findings[0]?.reportDisposition).toBe("needs_human");
});

it.each(["//outside.invalid/path", "/api/../private", "/api2/resource", "/api/%2e%2e/private", "/api/\\outside"])("rejects escaped or prefix-confused paths: %s", async pathname => {
  const p = profile(); p.navigation.allowedPathPrefixes = ["/api"];
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  const runDir = dir();
  await runApiChecks(p, [api(pathname)], runDir, 1, "http://localhost:4173");
  expect(fetcher).not.toHaveBeenCalled();
  expect(loadCheckLedger(runDir).entries[0]?.classification).toBe("unsupported");
});

it("caps bytes while streaming and cancels without consuming an endless response", async () => {
  let pulls = 0; let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; if (pulls > 8) { controller.error(new Error("unbounded read")); return; } controller.enqueue(new TextEncoder().encode("é".repeat(20))); }, cancel() { cancelled = true; } });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
  const result = await fireCheckRequest("http://localhost/a", "GET", undefined, 64);
  expect("failed" in result).toBe(true);
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThan(8);
});

it("never performs cross-account login against a real target", async () => {
  const p = profile(); p.target.environmentKind = "owned-sandbox";
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  const runDir = dir();
  await runSecurityChecks(p, [{ id: "boundary", kind: "session-boundary", pathname: "/", description: "local only", sessionBoundary: { loginPathname: "/api/login-demo", accountAId: "demo-a", accountBId: "demo-b", resourcePathnameTemplate: "/api/account/{accountId}/resource" } }], runDir, 1, "http://localhost:4173");
  expect(fetcher).not.toHaveBeenCalled();
  expect(loadCheckLedger(runDir).entries[0]?.classification).toBe("unsupported");
});

it("shares the request limit between API confirmations and security probes", async () => {
  const p = profile(); p.limits.maxApiRequests = 2;
  const budget = checkBudget(p);
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 500 }));
  const runDir = dir();
  await runApiChecks(p, [api()], runDir, 1, "http://localhost:4173", [], undefined, budget);
  await runSecurityChecks(p, [{ id: "headers", kind: "security-headers", pathname: "/", description: "headers" }], runDir, 2, "http://localhost:4173", [], undefined, budget);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(budget.used).toBe(2);
  expect(loadCheckLedger(runDir).entries[1]?.classification).toBe("unsupported");
});

it("never automatically replays an explicitly authorized mutation", async () => {
  const p = profile(); p.apiChecks.allowedMutatingEndpoints = [{ method: "POST", pathname: "/api/broken" }];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 500 }));
  const result = await runApiChecks(p, [{ ...api(), method: "POST" }], dir(), 1, "http://localhost:4173");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.findings[0]?.reproduction?.attempts).toBe(1);
  expect(result.findings[0]?.reportDisposition).toBe("needs_human");
});

it("does not call a different failure a reproduction", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 500 })).mockResolvedValueOnce(new Response("{}", { status: 404 }));
  const result = await runApiChecks(profile(), [api()], dir(), 1, "http://localhost:4173");
  expect(result.findings[0]?.reportDisposition).toBe("needs_human");
});

it.each([
  { status: 200, owner: "demo-b", expected: "confirmed" },
  { status: 200, owner: "demo-a", expected: "needs_review" },
  { status: 500, owner: "", expected: "needs_review" },
  { status: 403, owner: "", expected: "passed" },
])("requires resource ownership evidence, not just HTTP status: $status/$owner", async ({ status, owner, expected }) => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("{}", { headers: { "set-cookie": "session=a; Path=/" } }))
    .mockResolvedValueOnce(new Response("{}", { headers: { "set-cookie": "session=b; Path=/" } }))
    .mockResolvedValueOnce(Response.json({ resourceOwner: "demo-b", secretNote: "private" }))
    .mockResolvedValueOnce(Response.json({ resourceOwner: owner }, { status }));
  const runDir = dir();
  await runSecurityChecks(profile(), [{ id: "boundary", kind: "session-boundary", pathname: "/", description: "local only", sessionBoundary: { loginPathname: "/api/login-demo", accountAId: "demo-a", accountBId: "demo-b", resourcePathnameTemplate: "/api/account/{accountId}/resource" } }], runDir, 1, "http://localhost:4173");
  expect(loadCheckLedger(runDir).entries[0]?.classification).toBe(expected);
});

it("checks every cookie and never treats attribute words in a value as attributes", async () => {
  const headers = new Headers();
  headers.append("set-cookie", "one=abc; Secure; HttpOnly; SameSite=Strict");
  headers.append("set-cookie", "two=HttpOnlySecureSameSite");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { headers }));
  const runDir = dir();
  await runSecurityChecks(profile(), [{ id: "cookie", kind: "cookie-attributes", pathname: "/", description: "cookies" }], runDir, 1, "http://localhost:4173");
  expect(loadCheckLedger(runDir).entries[0]?.classification).toBe("needs_review");
});

it("redacts non-string secrets, named header pairs and JSON embedded in text responses", () => {
  const result = redactStructuredEvidence({ password: 1234, apiKey: ["private"], headers: [{ name: "Set-Cookie", value: "session=hidden" }], raw: '{"password":"unlisted-value"}' });
  const text = JSON.stringify(result);
  for (const secret of ["1234", "private", "hidden", "unlisted-value"]) expect(text).not.toContain(secret);
  expect(JSON.parse(text)).toBeTruthy();
});

it("does not pass missing equality operands or inherited JSON fields", () => {
  expect(evaluateAssertions({ requiredFields: ["constructor"], invariants: [{ kind: "fieldsEqual", field: "a", field2: "b" }] }, 200, "application/json", {})).toHaveLength(2);
});

it("does not silently send an unauthenticated request for an authenticated profile", async () => {
  const p = profile(); p.auth = { mode: "form-login", checksVerified: true, allowedRequests: [] };
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  const runDir = dir();
  await runApiChecks(p, [api()], runDir, 1, "http://localhost:4173");
  expect(fetcher).not.toHaveBeenCalled();
  const entry = loadCheckLedger(runDir).entries[0];
  expect(entry?.blockedReason).toContain("no anonymous request was sent");
  expect(entry?.session).toBe("unavailable");
});

it("still sends nothing anonymously when useRunSession is enabled but the run has no authenticated session", async () => {
  const p = profile(); p.auth = { mode: "form-login", checksVerified: true, allowedRequests: [] }; p.apiChecks.useRunSession = true;
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  const runDir = dir();
  await runApiChecks(p, [api()], runDir, 1, "http://localhost:4173", [], undefined, undefined, { authenticated: false, cookieHeaderFor: async () => "session=should-never-be-read" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(loadCheckLedger(runDir).entries[0]?.blockedReason).toContain("No authenticated session exists for this run");
});
