import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureOptions, type AuthFixtureServer, type FixtureBugs } from "../../fixture/auth-server.js";
import { consistencyCheckSchema, consistencyProblems, type ConsistencyCheck, type DeclaredApiCheck } from "../../src/checks/checks-manifest.js";
import { compareObservations, dataChanged, type Observation } from "../../src/checks/consistency.js";
import { approveBaseline } from "../../src/suites/baselines.js";
import { findSuite, saveSuite, suiteContentHash } from "../../src/suites/suite-manifest.js";
import { runSuite, suiteEnvironment } from "../helpers/suite-env.js";

let server: AuthFixtureServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

const LIST: DeclaredApiCheck = { id: "LIST", method: "GET", pathname: "/api/statement-list", description: "Statement list, first page", query: { page: "1", pageSize: "5" }, evidence: "structure-only", assertions: { expectedStatus: 200, shape: { items: "array" }, invariants: [] } };
const declaration = (patch: Partial<ConsistencyCheck> = {}): ConsistencyCheck => consistencyCheckSchema.parse({
  id: "UI-API-STATUS", description: "Statement status on the list page matches the API", workflowId: "OPEN-STATEMENTS",
  ui: { table: "Statement results", keyColumn: "Merchant", valueColumn: "Status" },
  api: { checkId: "LIST", itemsPath: "items", keyField: "merchant", valueField: "status" },
  relation: "status-equal", scope: { pageParam: "page", pageSizeParam: "pageSize", pageSize: 5 }, mode: "separate-check", ...patch,
});

async function environment(options: AuthFixtureOptions = {}, comparison: ConsistencyCheck = declaration(), limits: Record<string, number> = {}) {
  server = await startAuthFixtureServer(options);
  const env = suiteEnvironment(server.origin, { limits });
  writeFileSync(join(env.profilesDir, "demo.checks.json"), JSON.stringify({ schemaVersion: 1, profileId: "demo", apiChecks: [LIST], securityChecks: [], consistencyChecks: [comparison] }));
  saveSuite(env.store, "demo", { id: "ui-api", name: "UI–API", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }, { kind: "consistency-check", id: comparison.id, required: true }], limits: {} });
  return env;
}

const item = (run: Awaited<ReturnType<typeof runSuite>>) => run.result.items.find((i) => i.kind === "consistency-check")!;
const evidence = (run: Awaited<ReturnType<typeof runSuite>>) => JSON.parse(readFileSync(join(run.dir, "checks", "UI-API-STATUS", "consistency.json"), "utf-8")) as { mode: string; assumption: string; attempts: Array<{ attempt: number; verdict: string; reasonCode: string }>; outcome: { verdict: string; reasonCode: string } };

describe("UI–API comparison: pure rules", () => {
  const obs = (pairs: Array<[string, string | undefined]>, valueType = "string"): Observation => ({ records: pairs.map(([key, value]) => ({ key, value, valueType: value === undefined ? "missing" : valueType })), readAt: "t" });
  const check = declaration();

  it("matches records by key, normalizes status text and reports mismatches without values", () => {
    expect(compareObservations(check, obs([["Coffee House", " Pending "], ["Book Nook", "paid"]]), obs([["Book Nook", "PAID"], ["Coffee House", "pending"]])).verdict).toBe("pass");
    const mismatch = compareObservations(check, obs([["Coffee House", "pending"], ["Book Nook", "paid"]]), obs([["Coffee House", "pending"], ["Book Nook", "pending"]]));
    expect(mismatch).toMatchObject({ verdict: "mismatch", detail: "1 of 2 matched record(s) differ; values not recorded." });
    expect(JSON.stringify(mismatch.sanitized)).not.toMatch(/Book|Coffee|paid|pending/);
    // No value lengths either: for a short status, the length alone identifies the value.
    expect(mismatch.sanitized.every((r) => Object.keys(r).sort().join() === "apiType,equal,record")).toBe(true);
  });

  it("is not assessed for duplicate keys, no common records or a missing API field", () => {
    expect(compareObservations(check, obs([["A", "x"], ["A", "y"]]), obs([["A", "x"]])).reasonCode).toBe("ambiguous-identity");
    expect(compareObservations(check, obs([["A", "x"]]), obs([["B", "x"]])).reasonCode).toBe("ambiguous-identity");
    expect(compareObservations(check, obs([["A", "x"]]), obs([["A", undefined]])).reasonCode).toBe("missing-field");
  });

  it("compares counts only within the same page scope", () => {
    const count = declaration({ relation: "count-equal" });
    expect(compareObservations(count, { records: [], uiRowCount: 5, readAt: "t" }, { records: [], apiItemCount: 5, readAt: "t" }).verdict).toBe("pass");
    expect(compareObservations({ ...count, scope: { ...count.scope, pageSize: 3 } }, { records: [], uiRowCount: 5, readAt: "t" }, { records: [], apiItemCount: 3, readAt: "t" }).reasonCode).toBe("scope-mismatch");
  });

  it("detects data that changed between two observations", () => {
    const a = compareObservations(check, obs([["A", "paid"]]), obs([["A", "pending"]]));
    const same = compareObservations(check, obs([["A", "paid"]]), obs([["A", "pending"]]));
    const changed = compareObservations(check, obs([["A", "paid"]]), obs([["A", "paid"]]));
    expect(dataChanged(a, same)).toBe(false);
    expect(dataChanged(a, changed)).toBe(true);
  });

  it("refuses unsound declarations before anything runs", () => {
    expect(consistencyProblems(declaration({ ui: { table: "Statement results", keyColumn: "Merchant", valueColumn: "Amount" }, api: { checkId: "LIST", itemsPath: "items", keyField: "merchant", valueField: "amount" } }), [LIST]).join(" ")).toContain("monetary");
    expect(consistencyProblems(declaration({ scope: { pageParam: "page", pageSizeParam: "pageSize", pageSize: 10 } }), [LIST]).join(" ")).toContain("same page size");
    expect(consistencyProblems(declaration({ relation: "count-equal", scope: {} }), [LIST]).join(" ")).toContain("never compared with an application-wide total");
    expect(consistencyProblems(declaration(), [{ ...LIST, evidence: undefined }]).join(" ")).toContain("structure-only");
    expect(consistencyProblems(declaration(), [LIST])).toEqual([]);
  });
});

describe("UI–API comparison in a suite run (synthetic fixture)", () => {
  it("passes when the UI and the separately sent API check agree, stating the timing assumption", async () => {
    const env = await environment();
    const run = await runSuite(env, "ui-api");
    expect(run.result.decision).toBe("PASS");
    expect(item(run)).toMatchObject({ status: "passed", assertions: [expect.objectContaining({ id: "consistency:status", verdict: "pass" })] });
    expect(evidence(run)).toMatchObject({ mode: "separate-check", attempts: [{ attempt: 1, verdict: "pass" }] });
    expect(evidence(run).assumption).toContain("not an atomic snapshot");
  }, 120_000);

  it("fails only on a mismatch reproduced on both sides, keeps both attempts, and a corrected API then passes with the baseline showing it fixed", async () => {
    const env = await environment({ bugs: { apiStatusMismatch: true } });
    const failing = await runSuite(env, "ui-api");
    expect(failing.result.decision).toBe("FAIL");
    expect(item(failing)).toMatchObject({ status: "failed", attempts: { total: 2, failed: 2 }, reproduced: true });
    expect(evidence(failing).attempts.map((a) => a.verdict)).toEqual(["mismatch", "mismatch"]);
    // Privacy: no compared key or value reaches any comparison artifact.
    for (const file of ["check-results.json", "suite-result.json", "coverage-report.md", join("checks", "UI-API-STATUS", "consistency.json")]) {
      const text = readFileSync(join(failing.dir, file), "utf-8");
      for (const value of ["Book Nook", "Coffee House", "\"paid\"", "\"pending\""]) expect(text, `${file} contains ${value}`).not.toContain(value);
    }
    server!.setBugs({});
    const baselineSuite = findSuite(env.profilesDir, "demo", "ui-api");
    const corrected = await runSuite(env, "ui-api");
    expect(corrected.result.decision).toBe("PASS");
    approveBaseline(env.profilesDir, env.runsDir, "demo", baselineSuite, suiteContentHash(baselineSuite), corrected.runId);
    server!.setBugs({ apiStatusMismatch: true } satisfies FixtureBugs);
    const regressed = await runSuite(env, "ui-api");
    expect(regressed.comparison?.entries.find((e) => e.identity === "consistency-check:UI-API-STATUS#consistency:status")?.category).toBe("newly-failing");
  }, 240_000);

  it("reports data that changed between observations as not assessed, never as a mismatch or a pass", async () => {
    const env = await environment({ bugs: { apiStatusFlapping: true } });
    const run = await runSuite(env, "ui-api");
    expect(item(run)).toMatchObject({ status: "not-executed", reasonCode: "data-changed" });
    expect(evidence(run).attempts.map((a) => a.verdict)).toEqual(["mismatch", "pass"]);
    expect(run.result.decision).toBe("INCOMPLETE");
  }, 120_000);

  it("reports a missing API field as not assessed", async () => {
    const env = await environment({ bugs: { apiMissingField: true } });
    const run = await runSuite(env, "ui-api");
    expect(item(run)).toMatchObject({ status: "not-executed", reasonCode: "missing-field" });
  }, 120_000);

  it("rendering-response mode compares the table with the response the page rendered it from, with no extra request", async () => {
    const env = await environment({ statementListApi: "client" }, declaration({ mode: "rendering-response" }));
    const run = await runSuite(env, "ui-api");
    expect(item(run)).toMatchObject({ status: "passed" });
    expect(evidence(run).mode).toBe("rendering-response");
    // One call when the workflow opened the page, one when the comparison reopened it: none sent by AutoQA itself.
    expect(server!.hits.get("GET /api/statement-list")).toBe(2);
    server!.setBugs({ uiStatusAlwaysPaid: true });
    const broken = await runSuite(env, "ui-api");
    expect(item(broken)).toMatchObject({ status: "failed", reproduced: true });
  }, 240_000);

  it("Stop during a comparison leaves it not assessed (the first mismatch is kept), and the next run completes", async () => {
    let stop: (() => void) | undefined;
    const env = await environment({ bugs: { apiStatusMismatch: true }, onStatementList: (n) => { if (n === 2) stop?.(); } });
    const stopped = await runSuite(env, "ui-api", {}, (runId) => { stop = () => env.manager.stopRun(runId); });
    expect(item(stopped)).toMatchObject({ status: "not-executed", reasonCode: "cancelled" });
    expect(evidence(stopped).attempts.map((a) => a.verdict)).toEqual(["mismatch", "not-assessed"]);
    stop = undefined;
    const next = await runSuite(env, "ui-api");
    expect(item(next)).toMatchObject({ status: "failed", reproduced: true });
  }, 240_000);

  it("is not assessed when the request budget cannot cover the comparison", async () => {
    const env = await environment({}, declaration(), { maxApiRequests: 1 });
    const run = await runSuite(env, "ui-api");
    expect(item(run)).toMatchObject({ status: "not-executed", reasonCode: "budget-exhausted" });
  }, 120_000);

  it("is not assessed (not a failure) when sign-in fails", async () => {
    const env = await environment();
    const run = await runSuite(env, "ui-api", { credentials: { username: "demo-a", password: "wrong-password" } });
    expect(run.result.decision).toBe("INCOMPLETE");
    expect(item(run).status).toBe("not-executed");
  }, 120_000);
});
