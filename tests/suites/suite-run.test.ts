import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { targetIdentity } from "../../src/profiles/fingerprint.js";
import { RunAlreadyActiveError, SuiteInvalidError } from "../../src/run-manager.js";
import { approveBaseline, baselineEligibility, currentBaseline } from "../../src/suites/baselines.js";
import { findSuite, saveSuite, suiteContentHash } from "../../src/suites/suite-manifest.js";
import { credentials, runSuite, suiteEnvironment } from "../helpers/suite-env.js";

/**
 * Regression suites end to end: real Chromium, the synthetic sign-in
 * fixture, mock providers, no keys. Each seeded regression is switched on
 * with the fixture's setBugs() between runs.
 */
let server: AuthFixtureServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

const totalHits = () => [...server!.hits.values()].reduce((a, b) => a + b, 0);
function dirHash(dir: string): string {
  const hash = createHash("sha256");
  const walk = (d: string) => { for (const name of readdirSync(d).sort()) { const p = join(d, name); if (statSync(p).isDirectory()) walk(p); else hash.update(name).update(readFileSync(p)); } };
  walk(dir);
  return hash.digest("hex");
}

async function setup() {
  server = await startAuthFixtureServer();
  const env = suiteEnvironment(server.origin);
  saveSuite(env.store, "demo", { id: "smoke", name: "Smoke", description: "Statements and profile API", items: [
    { kind: "workflow", id: "OPEN-STATEMENTS", required: true },
    { kind: "api-check", id: "ME", required: true },
    { kind: "security-check", id: "HEADERS", required: false },
  ], limits: {} });
  const approve = (runId: string, replace = false) => {
    const suite = findSuite(env.profilesDir, "demo", "smoke");
    return approveBaseline(env.profilesDir, env.runsDir, "demo", suite, suiteContentHash(suite), runId, { replace });
  };
  return { env, approve };
}

describe("regression suites: seeded regressions are detected, fixes recognised, misleading comparisons refused", () => {
  it("healthy baseline → workflow regression → API regression → fix, compared by assertion identity", async () => {
    const { env, approve } = await setup();

    const healthy = await runSuite(env, "smoke");
    expect(healthy.result.decision).toBe("PASS");
    expect(healthy.result.items.find((i) => i.itemId === "HEADERS")?.status).toBe("failed"); // optional: never decides
    expect(healthy.comparison?.comparable).toBe(false);
    expect(healthy.comparison?.reason).toContain("No approved baseline");
    const before = dirHash(healthy.dir);
    approve(healthy.runId);
    expect(dirHash(healthy.dir)).toBe(before); // approving never rewrites the run

    // Seeded workflow regression: the Statements heading is renamed.
    server!.setBugs({ statementsHeadingChanged: true });
    const workflowRegression = await runSuite(env, "smoke");
    expect(workflowRegression.result.decision).toBe("FAIL");
    const wf = workflowRegression.comparison!.entries.find((e) => e.identity === "workflow:OPEN-STATEMENTS#visible")!;
    expect(wf).toMatchObject({ category: "newly-failing", expected: "heading Statements", observed: "not visible", baselineObserved: "visible" });
    expect(wf.reproduction).toContain("failed 2 of 2 attempt(s)");
    expect(wf.reproduction).toContain("Not labelled flaky");
    expect(workflowRegression.comparison!.entries.find((e) => e.identity === "workflow:OPEN-STATEMENTS#url")?.category).toBe("unchanged-passing");
    expect(workflowRegression.comparison!.entries.find((e) => e.identity === "api-check:ME#status")?.category).toBe("unchanged-passing");
    // The existing optional security finding is recognised as the same finding.
    expect(workflowRegression.comparison!.entries.find((e) => e.identity === "security-check:HEADERS#header:content-security-policy")).toMatchObject({ category: "still-failing", sameFindingAsBaseline: true });
    // HSTS cannot be assessed over http:// (RFC 6797): reported as not executed, never as a pass or a failure.
    expect(workflowRegression.comparison!.entries.find((e) => e.identity === "security-check:HEADERS#header:strict-transport-security")?.category).toBe("not-executed");
    expect(baselineEligibility(env.runsDir, workflowRegression.runId, "demo", findSuite(env.profilesDir, "demo", "smoke"))).toMatchObject({ eligible: false, reason: expect.stringContaining("A required item failed") });
    // The baseline was not replaced by the newer run.
    expect(currentBaseline(env.profilesDir, "demo", "smoke")?.runId).toBe(healthy.runId);

    // Seeded API regression instead.
    server!.setBugs({ apiMeMissingEmail: true });
    const apiRegression = await runSuite(env, "smoke");
    expect(apiRegression.result.decision).toBe("FAIL");
    const api = apiRegression.comparison!.entries.find((e) => e.identity === "api-check:ME#field:email")!;
    expect(api).toMatchObject({ category: "newly-failing", expected: "present", observed: "missing" });
    expect(apiRegression.comparison!.entries.find((e) => e.identity === "api-check:ME#field:id")?.category).toBe("unchanged-passing");
    expect(api.evidenceRefs.some((r) => r.startsWith("findings/"))).toBe(true);

    // Corrected.
    server!.setBugs({});
    const fixedRun = await runSuite(env, "smoke");
    expect(fixedRun.result.decision).toBe("PASS");
    expect(fixedRun.comparison!.counts["newly-failing"]).toBe(0);
    expect(fixedRun.comparison!.counts["unchanged-passing"]).toBeGreaterThan(0);
    // Nothing secret in any suite artifact.
    for (const run of [healthy, workflowRegression, apiRegression, fixedRun]) {
      for (const file of ["suite-run.json", "suite-result.json", "suite-comparison.json"]) expect(readFileSync(join(run.dir, file), "utf-8")).not.toContain(credentials.password);
    }
  }, 300_000);

  it("a baseline with a known optional failure recognises the fix as 'fixed'", async () => {
    server = await startAuthFixtureServer({ bugs: { apiMeMissingEmail: true } });
    const env = suiteEnvironment(server.origin);
    saveSuite(env.store, "demo", { id: "opt", name: "Optional API", description: "", items: [
      { kind: "workflow", id: "OPEN-STATEMENTS", required: true },
      { kind: "api-check", id: "ME", required: false },
    ], limits: {} });
    const baseline = await runSuite(env, "opt");
    expect(baseline.result.decision).toBe("PASS");
    const suite = findSuite(env.profilesDir, "demo", "opt");
    approveBaseline(env.profilesDir, env.runsDir, "demo", suite, suiteContentHash(suite), baseline.runId);
    server.setBugs({});
    const after = await runSuite(env, "opt");
    expect(after.comparison!.entries.find((e) => e.identity === "api-check:ME#field:email")).toMatchObject({ category: "fixed", baselineObserved: "missing", observed: "as expected" });
  }, 200_000);

  it("authentication failure makes the suite INCOMPLETE and nothing is called a regression", async () => {
    const { env, approve } = await setup();
    const healthy = await runSuite(env, "smoke");
    approve(healthy.runId);
    const loginsBefore = server!.hits.get("POST /session") ?? 0;
    const failedLogin = await runSuite(env, "smoke", { credentials: { username: "demo-a", password: "wrong-synthetic-password" } });
    // The rejected password was submitted once, never retried (a retry could lock a real account).
    expect((server!.hits.get("POST /session") ?? 0) - loginsBefore).toBe(1);
    expect(failedLogin.result.authentication).toBe("failed");
    expect(failedLogin.result.decision).toBe("INCOMPLETE");
    expect(failedLogin.result.coverageGaps.map((g) => g.identity).sort()).toEqual(["api-check:ME", "workflow:OPEN-STATEMENTS"]);
    expect(failedLogin.comparison!.counts["newly-failing"]).toBe(0);
    expect(failedLogin.comparison!.counts["not-executed"]).toBeGreaterThan(0);
    expect(failedLogin.comparison!.notes.join(" ")).toContain("Authentication failed");
    expect(readFileSync(join(failedLogin.dir, "suite-result.json"), "utf-8")).not.toContain("wrong-synthetic-password");
  }, 200_000);

  it("cancellation is INCOMPLETE and can never become a baseline; a duplicate start is refused", async () => {
    const { env } = await setup();
    const started = runSuite(env, "smoke", {}, (runId) => { env.manager.stopRun(runId); });
    await expect(env.manager.startRun({ profileId: "demo", mode: "demo", credentials, suiteId: "smoke", expected: targetIdentity(env.store, "demo") })).rejects.toBeInstanceOf(RunAlreadyActiveError);
    const cancelled = await started;
    expect(cancelled.result.runStatus).toBe("cancelled");
    expect(cancelled.result.decision).toBe("INCOMPLETE");
    expect(cancelled.result.coverageGaps.every((g) => g.reasonCode === "cancelled")).toBe(true);
    expect(baselineEligibility(env.runsDir, cancelled.runId, "demo", findSuite(env.profilesDir, "demo", "smoke"))).toEqual({ eligible: false, reason: "This run was cancelled, so it can't be a passing baseline." });
  }, 200_000);

  it("budget exhaustion and unsupported required behaviour are coverage gaps, not passes", async () => {
    server = await startAuthFixtureServer();
    const env = suiteEnvironment(server.origin);
    env.writeChecks([
      { id: "ME", method: "GET", pathname: "/api/me", description: "Profile", assertions: { expectedStatus: 200 } },
      { id: "STATEMENTS", method: "GET", pathname: "/api/statements", description: "Statements list", assertions: { expectedStatus: 200 } },
      { id: "TRANSFER", method: "POST", pathname: "/api/transfer", description: "Never sent", assertions: { expectedStatus: 200 } },
    ], []);
    saveSuite(env.store, "demo", { id: "budget", name: "Budget", description: "", items: [
      { kind: "api-check", id: "ME", required: true },
      { kind: "api-check", id: "STATEMENTS", required: true },
      { kind: "api-check", id: "TRANSFER", required: true },
    ], limits: { maxApiRequests: 1 } });
    const run = await runSuite(env, "budget");
    const status = (id: string) => run.result.items.find((i) => i.itemId === id)!;
    expect(status("ME").status).toBe("passed");
    expect(status("STATEMENTS")).toMatchObject({ status: "not-executed", reason: expect.stringContaining("budget") });
    expect(status("TRANSFER")).toMatchObject({ status: "unsupported", reason: expect.stringContaining("not present in apiChecks.allowedMutatingEndpoints") });
    expect(run.result.decision).toBe("INCOMPLETE");
    expect(run.result.executionSettings.effectiveLimits.maxApiRequests).toBe(1);
    expect(server.hits.get("POST /api/transfer") ?? 0).toBe(0);
    // Checks-only suite: signed in, no workflow executed.
    expect(readdirSync(run.dir)).not.toContain("workflows");
  }, 200_000);

  it("a renamed check or a changed configuration is rejected before any request; a re-saved suite compares only what is comparable", async () => {
    const { env, approve } = await setup();
    const healthy = await runSuite(env, "smoke");
    approve(healthy.runId);

    // Renamed check: the suite is stale and nothing is sent.
    env.writeChecks([{ id: "ME-RENAMED", method: "GET", pathname: "/api/me", description: "Profile", assertions: { expectedStatus: 200, requiredFields: ["id", "email"] } }]);
    const hitsBefore = totalHits();
    await expect(env.manager.startRun({ profileId: "demo", mode: "demo", credentials, suiteId: "smoke", expected: targetIdentity(env.store, "demo") }))
      .rejects.toThrow(/ME no longer exists/);
    expect(totalHits()).toBe(hitsBefore);

    // Changed assertion definition, suite re-saved as revision 2 → that item is incomparable; the others still compare.
    env.writeChecks([{ id: "ME", method: "GET", pathname: "/api/me", description: "Profile", assertions: { expectedStatus: 200, requiredFields: ["id"] } }]);
    await expect(env.manager.startRun({ profileId: "demo", mode: "demo", credentials, suiteId: "smoke", expected: targetIdentity(env.store, "demo") })).rejects.toBeInstanceOf(SuiteInvalidError);
    expect(totalHits()).toBe(hitsBefore);
    const rev2 = saveSuite(env.store, "demo", { id: "smoke", name: "Smoke", description: "", items: [
      { kind: "workflow", id: "OPEN-STATEMENTS", required: true },
      { kind: "api-check", id: "ME", required: true },
    ], limits: {} });
    expect(rev2.revision).toBe(2);
    const afterEdit = await runSuite(env, "smoke");
    expect(afterEdit.comparison!.comparable).toBe(true);
    expect(afterEdit.comparison!.notes.join(" ")).toContain("revision changed from 1");
    expect(afterEdit.comparison!.entries.find((e) => e.identity === "api-check:ME")).toMatchObject({ category: "incomparable" });
    expect(afterEdit.comparison!.entries.find((e) => e.identity === "security-check:HEADERS")).toMatchObject({ category: "removed" });
    expect(afterEdit.comparison!.entries.find((e) => e.identity === "workflow:OPEN-STATEMENTS#visible")?.category).toBe("unchanged-passing");

    // Changed API session mode: the suite must be re-saved, and the old baseline is then incomparable as a whole.
    const profile = JSON.parse(readFileSync(join(env.profilesDir, "demo.json"), "utf-8"));
    env.writeProfile({ apiChecks: { ...profile.apiChecks, runSessionAuth: "observed-authorization" } });
    await expect(env.manager.startRun({ profileId: "demo", mode: "demo", credentials, suiteId: "smoke", expected: targetIdentity(env.store, "demo") })).rejects.toThrow(/API session mode changed/);
    saveSuite(env.store, "demo", { id: "smoke", name: "Smoke", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }], limits: {} });
    const modeChanged = await runSuite(env, "smoke");
    expect(modeChanged.comparison).toMatchObject({ comparable: false, reason: expect.stringContaining("API session mode changed") });
    expect(modeChanged.comparison!.entries).toEqual([]);
  }, 300_000);
});
