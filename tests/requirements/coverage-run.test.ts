import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { saveApiChecks } from "../../src/checks/checks-manifest.js";
import { scopedCheckUrl } from "../../src/checks/request-scope.js";
import { buildContractDrafts, parseContract } from "../../src/contracts/openapi.js";
import type { CoverageComparison, RequirementCoverage } from "../../src/requirements-coverage/coverage.js";
import { approveRequirement, saveRequirement } from "../../src/requirements-coverage/requirements.js";
import type { CoverageReport } from "../../src/reporting/coverage-report.js";
import { approveBaseline } from "../../src/suites/baselines.js";
import { findSuite, saveSuite, suiteContentHash } from "../../src/suites/suite-manifest.js";
import { credentials, runSuite, suiteEnvironment } from "../helpers/suite-env.js";

/**
 * Requirements coverage, contract checks and per-assertion security results
 * end to end: real Chromium, the synthetic sign-in fixture, mock providers.
 */
let server: AuthFixtureServer | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await server?.close(); server = undefined;
  for (const c of closers.splice(0)) await c();
});

async function untrustedHost() {
  let hits = 0;
  const s: Server = createServer((_q, r) => { hits++; r.end("{}"); });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }));
  return { origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits: () => hits };
}

async function setup() {
  server = await startAuthFixtureServer({ securityHeaders: "partial" });
  const untrusted = await untrustedHost();
  const env = suiteEnvironment(server.origin);
  const profile = env.store.load("demo");
  // The contract's servers point at another (counting) host: it must never be contacted.
  const doc = JSON.parse(readFileSync("fixture/contracts/accounts.openapi.json", "utf-8"));
  doc.servers = [{ url: untrusted.origin }];
  doc.paths["/api/accounts/{accountId}"].servers = [{ url: `${untrusted.origin}/v2` }];
  const contract = parseContract(JSON.stringify(doc));
  const [draft] = buildContractDrafts(contract, "accounts.openapi.json", [{ operation: "GET /api/accounts/{accountId}", pathParams: { accountId: "acc-1" }, queryParams: {} }], (p) => Boolean(scopedCheckUrl(profile, server!.origin, p)));
  expect(draft!.executable).toBe(true);
  saveApiChecks(env.profilesDir, "demo", [draft!.check!]);
  saveSuite(env.store, "demo", { id: "accounts", name: "Accounts", description: "", items: [
    { kind: "workflow", id: "OPEN-STATEMENTS", required: true },
    { kind: "api-check", id: "CONTRACT-GETACCOUNT", required: true },
    { kind: "security-check", id: "HEADERS", required: false },
  ], limits: {} });
  const approve = (id: string, revision = 1) => approveRequirement(env.store, "demo", id, revision);
  saveRequirement(env.store, "demo", { id: "REQ-ACCOUNT", title: "Account details follow the published contract", description: "", importance: "critical", criteria: [
    { id: "C1", description: "Status is one of the declared values", required: true, links: [{ kind: "api-check", itemId: "CONTRACT-GETACCOUNT", assertionId: "contract:$.status:enum" }, { kind: "api-check", itemId: "CONTRACT-GETACCOUNT", assertionId: "contract:$.status:required" }] },
    { id: "C2", description: "Balance is expressed in integer minor units", required: true, links: [{ kind: "api-check", itemId: "CONTRACT-GETACCOUNT", assertionId: "contract:$.balance.minorUnits:type" }] },
    { id: "C3", description: "Responses declare a content security policy", required: false, links: [{ kind: "security-check", itemId: "HEADERS", assertionId: "header:content-security-policy" }] },
  ] });
  approve("REQ-ACCOUNT");
  saveRequirement(env.store, "demo", { id: "REQ-STATEMENTS", title: "Members can open their statements", description: "", importance: "high", criteria: [{ id: "C1", description: "The Statements page opens", required: true, links: [{ kind: "workflow", itemId: "OPEN-STATEMENTS", assertionId: "visible" }] }] });
  approve("REQ-STATEMENTS");
  saveRequirement(env.store, "demo", { id: "REQ-UNMAPPED", title: "Statements can be exported", description: "", importance: "medium", criteria: [{ id: "C1", description: "An export is offered", required: true, links: [] }] });
  approve("REQ-UNMAPPED");
  saveRequirement(env.store, "demo", { id: "REQ-PARTIAL", title: "Profile and statements are readable", description: "", importance: "medium", criteria: [
    { id: "C1", description: "Statements open", required: true, links: [{ kind: "workflow", itemId: "OPEN-STATEMENTS", assertionId: "url" }] },
    { id: "C2", description: "Profile readable", required: true, links: [{ kind: "api-check", itemId: "ME", assertionId: "status" }] },
  ] });
  approve("REQ-PARTIAL");
  saveRequirement(env.store, "demo", { id: "REQ-DRAFT", title: "Draft only", description: "", importance: "low", criteria: [{ id: "C1", description: "x", required: true, links: [] }] });
  return { env, untrusted, approve };
}

const coverageOf = (dir: string) => JSON.parse(readFileSync(join(dir, "requirement-coverage.json"), "utf-8")) as { coverage: RequirementCoverage; comparison: CoverageComparison };
const reportOf = (dir: string) => JSON.parse(readFileSync(join(dir, "coverage-report.json"), "utf-8")) as CoverageReport;
const reqStatus = (c: RequirementCoverage) => Object.fromEntries(c.requirements.map((r) => [r.requirementId, r.status]));

describe("requirement coverage across a healthy baseline, a seeded regression and a corrected run", () => {
  it("traces criteria to assertions, detects the contract regression and its fix, and refuses changed criteria", async () => {
    const { env, untrusted } = await setup();

    const healthy = await runSuite(env, "accounts");
    expect(healthy.result.decision).toBe("PASS");
    const c0 = coverageOf(healthy.dir).coverage;
    expect(reqStatus(c0)).toEqual({ "REQ-ACCOUNT": "passed", "REQ-STATEMENTS": "passed", "REQ-UNMAPPED": "not-assessed", "REQ-PARTIAL": "partially-assessed" });
    expect(c0.draftsExcluded).toBe(1);
    expect(c0.summary).toMatchObject({ approvedRequirements: 4, requirementsPassed: { numerator: 2, denominator: 4, percent: 50 }, requiredCriteria: 6, requiredCriteriaAssessed: { numerator: 4, denominator: 6 } });
    expect(c0.requirements.find((r) => r.requirementId === "REQ-UNMAPPED")!.criteria[0]!.reason).toContain("Unmapped");
    expect(c0.requirements.find((r) => r.requirementId === "REQ-PARTIAL")!.criteria[1]!.reason).toContain("not part of this suite");
    // Optional CSP criterion fails while the other header assertions pass and HSTS is not assessed over http.
    expect(c0.requirements.find((r) => r.requirementId === "REQ-ACCOUNT")!.criteria[2]!.status).toBe("failed");
    const headers = healthy.result.items.find((i) => i.itemId === "HEADERS")!;
    expect(Object.fromEntries(headers.assertions.map((a) => [a.id, a.verdict]))).toEqual({ "header:content-security-policy": "fail", "header:x-content-type-options": "pass", "header:x-frame-options": "pass", "header:strict-transport-security": "not-assessed" });
    const r0 = reportOf(healthy.dir);
    expect(r0.securityPolicyFindings.map((f) => f.identity)).toEqual(["security-check:HEADERS#header:content-security-policy"]);
    expect(r0.securityPolicyFindings[0]!.severityRationale).toContain("no exploit demonstrated");
    expect(r0.statement).toContain("does not mean the application is secure");
    const suite = findSuite(env.profilesDir, "demo", "accounts");
    approveBaseline(env.profilesDir, env.runsDir, "demo", suite, suiteContentHash(suite), healthy.runId);

    // Seeded regression: minorUnits becomes a string.
    server!.setBugs({ contractWrongType: true });
    const regression = await runSuite(env, "accounts");
    expect(regression.result.decision).toBe("FAIL");
    const c1 = coverageOf(regression.dir);
    expect(reqStatus(c1.coverage)["REQ-ACCOUNT"]).toBe("failed");
    expect(c1.comparison.entries.filter((e) => e.change === "newly-failing").map((e) => e.identity)).toEqual(["REQ-ACCOUNT#C2"]);
    const r1 = reportOf(regression.dir);
    expect(r1.contractMismatches).toEqual([expect.objectContaining({ identity: "api-check:CONTRACT-GETACCOUNT#contract:$.balance.minorUnits:type", expected: "integer", observed: "got string" })]);
    expect(r1.newlyFailingCriteria.map((e) => e.identity)).toEqual(["REQ-ACCOUNT#C2"]);
    expect(regression.comparison!.entries.find((e) => e.identity === "api-check:CONTRACT-GETACCOUNT#contract:$.balance.minorUnits:type")?.category).toBe("newly-failing");
    const md = readFileSync(join(regression.dir, "coverage-report.md"), "utf-8");
    expect(md).toContain("## Decision: FAIL");
    expect(md).toContain("REQ-ACCOUNT#C2");
    expect(md).not.toContain("Everyday"); // no response data in exports

    // Corrected.
    server!.setBugs({});
    const fixed = await runSuite(env, "accounts");
    expect(fixed.result.decision).toBe("PASS");
    const c2 = coverageOf(fixed.dir);
    expect(c2.comparison.entries.find((e) => e.identity === "REQ-ACCOUNT#C2")?.change).toBe("unchanged-passing");
    expect(c2.comparison.entries.filter((e) => e.change === "newly-failing")).toEqual([]);

    // Changed acceptance criteria: a new revision is compared as incomparable, never against the old one.
    saveRequirement(env.store, "demo", { id: "REQ-STATEMENTS", title: "Members can open their statements", description: "", importance: "high", criteria: [{ id: "C1", description: "The Statements page opens at /statements", required: true, links: [{ kind: "workflow", itemId: "OPEN-STATEMENTS", assertionId: "url" }] }] });
    approveRequirement(env.store, "demo", "REQ-STATEMENTS", 2);
    const changed = await runSuite(env, "accounts");
    expect(coverageOf(changed.dir).comparison.entries.find((e) => e.identity === "REQ-STATEMENTS#C1")).toMatchObject({ change: "incomparable", reason: expect.stringContaining("revision 1 to 2") });
    // Historical coverage is unchanged by the later edit.
    expect(coverageOf(healthy.dir).coverage.requirements.find((r) => r.requirementId === "REQ-STATEMENTS")!.revision).toBe(1);

    expect(untrusted.hits()).toBe(0);
    for (const run of [healthy, regression, fixed, changed]) expect(readFileSync(join(run.dir, "coverage-report.json"), "utf-8")).not.toContain(credentials.password);
  }, 400_000);

  it("malformed JSON and authentication failure are reported by code, not as passes or regressions", async () => {
    const { env } = await setup();
    const healthy = await runSuite(env, "accounts");
    const suite = findSuite(env.profilesDir, "demo", "accounts");
    approveBaseline(env.profilesDir, env.runsDir, "demo", suite, suiteContentHash(suite), healthy.runId);

    server!.setBugs({ contractMalformedJson: true });
    const malformed = await runSuite(env, "accounts");
    const item = malformed.result.items.find((i) => i.itemId === "CONTRACT-GETACCOUNT")!;
    expect(item.status).toBe("failed");
    expect(item.assertions.find((a) => a.id === "contract:json")).toMatchObject({ verdict: "fail", reasonCode: "malformed-response" });
    expect(item.assertions.find((a) => a.id === "contract:$.balance.minorUnits:type")?.verdict).toBe("not-assessed");
    const ledger = JSON.parse(readFileSync(join(malformed.dir, "check-results.json"), "utf-8")) as { schemaVersion: number; entries: Array<{ checkId: string; reasonCode: string }> };
    expect(ledger.schemaVersion).toBe(2);
    expect(ledger.entries.find((e) => e.checkId === "CONTRACT-GETACCOUNT")?.reasonCode).toBe("malformed-response");
    server!.setBugs({});

    const failedLogin = await runSuite(env, "accounts", { credentials: { username: "demo-a", password: "wrong-synthetic-password" } });
    expect(failedLogin.result.decision).toBe("INCOMPLETE");
    expect(failedLogin.result.coverageGaps.every((g) => g.reasonCode === "auth-failed")).toBe(true);
    const coverage = coverageOf(failedLogin.dir);
    expect(coverage.coverage.requirements.every((r) => r.status === "not-assessed")).toBe(true);
    expect(coverage.comparison.entries.filter((e) => e.change === "newly-failing")).toEqual([]);
    const report = reportOf(failedLogin.dir);
    expect(report.executionFailures.every((f) => f.reasonCode === "auth-failed")).toBe(true);
  }, 300_000);
});
