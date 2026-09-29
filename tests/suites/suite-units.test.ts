import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileStore } from "../../src/profiles/store.js";
import { approveBaseline, baselineEligibility, currentBaseline, loadBaselines, type Baseline } from "../../src/suites/baselines.js";
import { compareToBaseline } from "../../src/suites/compare.js";
import { buildSuiteResult, decideSuite, type SuiteItemResult, type SuiteResult, type SuiteRunSnapshot } from "../../src/suites/result.js";
import { canonicalJson, findSuite, loadSuites, saveSuite, SuiteError, suiteContentHash, validateSuite } from "../../src/suites/suite-manifest.js";
import { suiteEnvironment } from "../helpers/suite-env.js";
import { executionFor } from "../../src/outcomes/outcome.js";

const ORIGIN = "http://localhost:4987";

describe("suite manifest", () => {
  it("saves only approved items with server-computed hashes, bumps the revision, and never widens limits", () => {
    const env = suiteEnvironment(ORIGIN);
    const suite = saveSuite(env.store, "demo", { id: "s1", name: "S1", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }], limits: { maxActions: 10 } });
    expect(suite).toMatchObject({ revision: 1, target: { origin: ORIGIN, environmentKind: "owned-sandbox", authMode: "form-login", runSessionAuth: "cookie" } });
    expect(suite.items[0]!.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saveSuite(env.store, "demo", { id: "s1", name: "S1", description: "edited", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }], limits: {} }).revision).toBe(2);
    const reject = (input: Parameters<typeof saveSuite>[2]) => { try { saveSuite(env.store, "demo", input); return []; } catch (e) { return (e as SuiteError).errors; } };
    expect(reject({ id: "s2", name: "x", description: "", items: [{ kind: "workflow", id: "DRAFT-NOT-SAVED", required: true }], limits: {} }).join(" ")).toContain("not a saved workflow");
    expect(reject({ id: "s2", name: "x", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }], limits: { maxActions: 999 } }).join(" ")).toContain("suites can only lower limits");
    expect(reject({ id: "s2", name: "x", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: false }], limits: {} }).join(" ")).toContain("At least one item must be required");
    expect(reject({ id: "s2", name: "x", description: "", items: [], limits: {} }).join(" ")).toContain("no items");
    expect(reject({ id: "s2", name: "x", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }, { kind: "workflow", id: "OPEN-STATEMENTS", required: false }], limits: {} }).join(" ")).toContain("listed twice");
    expect(() => saveSuite(env.store, "demo", { id: "../evil", name: "x", description: "", items: [], limits: {} })).toThrow();
    expect(() => findSuite(env.profilesDir, "demo", "..\\evil")).toThrow("Invalid suite ID");
    // Suite files never appear as profiles.
    expect(env.store.list().map((p) => p.id)).toEqual(["demo"]);
  });

  it("detects a stale definition, a removed item and an incompatible target", () => {
    const env = suiteEnvironment(ORIGIN);
    const suite = saveSuite(env.store, "demo", { id: "s1", name: "S1", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }, { kind: "api-check", id: "ME", required: true }], limits: {} });
    expect(validateSuite(env.store, "demo", suite)).toEqual({ ok: true });
    env.writeChecks([{ id: "ME", method: "GET", pathname: "/api/me", description: "Profile", assertions: { expectedStatus: 201 } }]);
    expect(validateSuite(env.store, "demo", suite)).toEqual({ ok: false, errors: [expect.stringContaining("ME changed since suite revision 1")] });
    env.writeChecks([]);
    expect(validateSuite(env.store, "demo", suite)).toEqual({ ok: false, errors: [expect.stringContaining("ME no longer exists")] });
    env.writeChecks();
    env.writeProfile({ target: { url: "http://localhost:5999/home", environmentKind: "owned-sandbox" }, navigation: { allowedOrigins: ["http://localhost:5999"], allowedPathPrefixes: ["/"] } });
    const result = validateSuite(env.store, "demo", suite);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("now points to http://localhost:5999");
  });

  it("rejects a suites file that belongs to another profile or has unknown fields", () => {
    const env = suiteEnvironment(ORIGIN);
    writeFileSync(join(env.profilesDir, "demo.suites.json"), JSON.stringify({ schemaVersion: 1, profileId: "other", suites: [] }));
    expect(() => loadSuites(env.profilesDir, "demo")).toThrow(/belongs to profile "other"/);
    writeFileSync(join(env.profilesDir, "demo.suites.json"), JSON.stringify({ schemaVersion: 1, profileId: "demo", suites: [], extra: true }));
    expect(() => loadSuites(env.profilesDir, "demo")).toThrow(/invalid/);
  });

  it("hashes are independent of property order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: "z" } })).toBe(canonicalJson({ a: { c: "z", d: [1, { x: 1, y: 2 }] }, b: 1 }));
  });
});

const item = (over: Partial<SuiteItemResult>): SuiteItemResult => ({ identity: "workflow:W", kind: "workflow", itemId: "W", required: true, definitionHash: "a".repeat(64), status: "passed", reason: "", assertions: [], evidenceRefs: [], ...over });

describe("suite decision", () => {
  it("PASS, FAIL, INCOMPLETE, and FAIL with coverage gaps preserved together; optional items never decide", () => {
    expect(decideSuite([item({})]).decision).toBe("PASS");
    expect(decideSuite([item({}), item({ identity: "o", required: false, status: "failed" })]).decision).toBe("PASS");
    expect(decideSuite([item({ status: "not-executed", reason: "cancelled" })])).toMatchObject({ decision: "INCOMPLETE", coverageGaps: [{ identity: "workflow:W", status: "not-executed" }] });
    expect(decideSuite([item({ status: "unsupported" })]).decision).toBe("INCOMPLETE");
    const both = decideSuite([item({ status: "failed" }), item({ identity: "workflow:X", status: "not-executed", reason: "budget" })]);
    expect(both.decision).toBe("FAIL");
    expect(both.coverageGaps.map((g) => g.identity)).toEqual(["workflow:X"]);
    expect(both.decisionReason).toContain("coverage is also incomplete");
    expect(decideSuite([item({ required: false })]).decision).toBe("INCOMPLETE");
  });

  it("classifies checks that did not run by reason code only; rewording explanations never changes the decision", () => {
    const dir = mkdtempSync(join(tmpdir(), "autoqa-suite-codes-"));
    const snapshot: SuiteRunSnapshot = { schemaVersion: 1, runId: "RUN-C", profileId: "demo", suite: { id: "s", name: "S", revision: 1, contentHash: "c".repeat(64), items: [
      { kind: "api-check", id: "A", required: true, definitionHash: "a".repeat(64) }, { kind: "api-check", id: "B", required: true, definitionHash: "b".repeat(64) }, { kind: "api-check", id: "C", required: false, definitionHash: "c".repeat(64) }] },
      target: { origin: ORIGIN, environmentKind: "owned-sandbox", authMode: "none", runSessionAuth: "cookie" }, executionSettings: { limits: {}, effectiveLimits: { maxActions: 1, maxDurationMs: 1, maxApiRequests: 1 }, mode: "demo" }, recordedAt: "" };
    writeFileSync(join(dir, "run-summary.json"), JSON.stringify({ status: "completed", actionsPerformed: 0, modelCalls: 0 }));
    const ledger = (explain: (code: string) => string) => ({ schemaVersion: 2, entries: [
      { checkId: "A", kind: "api", ran: true, classification: "passed", reasonCode: "ok", assertion: "a", observation: explain("ok"), evidenceRefs: [] },
      { checkId: "B", kind: "api", ran: false, classification: "unsupported", reasonCode: "budget-exhausted", blockedReason: explain("budget-exhausted"), assertion: "b", observation: "Not run.", evidenceRefs: [] },
      { checkId: "C", kind: "api", ran: false, classification: "unsupported", reasonCode: "not-authorized", blockedReason: explain("not-authorized"), assertion: "c", observation: "Not run.", evidenceRefs: [] },
    ] });
    writeFileSync(join(dir, "check-results.json"), JSON.stringify(ledger((c) => `Original wording for ${c}.`)));
    const original = buildSuiteResult(dir, snapshot, false);
    // Same codes, deliberately misleading new wording: nothing structural changes.
    writeFileSync(join(dir, "check-results.json"), JSON.stringify(ledger(() => "Cancelled because the session expired and the budget ran out (all passed).")));
    const reworded = buildSuiteResult(dir, snapshot, false);
    const shape = (r: SuiteResult) => ({ decision: r.decision, items: r.items.map((i) => [i.itemId, i.status, i.reasonCode]), gaps: r.coverageGaps.map((g) => [g.identity, g.status, g.reasonCode]) });
    expect(shape(reworded)).toEqual(shape(original));
    expect(shape(original)).toEqual({ decision: "INCOMPLETE", items: [["A", "passed", "ok"], ["B", "not-executed", "budget-exhausted"], ["C", "unsupported", "not-authorized"]], gaps: [["api-check:B", "not-executed", "budget-exhausted"]] });
    expect(executionFor("cancelled")).toBe("not-executed");
    expect(executionFor("session-expired")).toBe("not-executed");
    expect(executionFor("scope-rejected")).toBe("unsupported");
  });

  it("reads version 1 ledgers structurally: recorded passes and failures stay, anything else is an unknown gap, never a guess", () => {
    const dir = mkdtempSync(join(tmpdir(), "autoqa-suite-legacy-"));
    const snapshot: SuiteRunSnapshot = { schemaVersion: 1, runId: "RUN-L", profileId: "demo", suite: { id: "s", name: "S", revision: 1, contentHash: "c".repeat(64), items: [
      { kind: "api-check", id: "P", required: true, definitionHash: "a".repeat(64) }, { kind: "api-check", id: "F", required: true, definitionHash: "b".repeat(64) }, { kind: "api-check", id: "N", required: true, definitionHash: "c".repeat(64) }, { kind: "security-check", id: "S", required: false, definitionHash: "d".repeat(64) }] },
      target: { origin: ORIGIN, environmentKind: "owned-sandbox", authMode: "none", runSessionAuth: "cookie" }, executionSettings: { limits: {}, effectiveLimits: { maxActions: 1, maxDurationMs: 1, maxApiRequests: 1 }, mode: "demo" }, recordedAt: "" };
    writeFileSync(join(dir, "run-summary.json"), JSON.stringify({ status: "completed", actionsPerformed: 0, modelCalls: 0 }));
    const before = JSON.stringify({ schemaVersion: 1, entries: [
      { checkId: "P", kind: "api", ran: true, classification: "passed", assertion: "p", observation: "ok", evidenceRefs: [] },
      { checkId: "F", kind: "api", ran: true, classification: "needs_review", assertion: "f", observation: "mismatch", evidenceRefs: [] },
      { checkId: "N", kind: "api", ran: false, classification: "unsupported", blockedReason: "API request budget exhausted.", assertion: "n", observation: "Not run.", evidenceRefs: [] },
      { checkId: "S", kind: "security", ran: true, classification: "needs_review", assertion: "headers", observation: "Missing security header(s): x.", evidenceRefs: [] },
    ] });
    writeFileSync(join(dir, "check-results.json"), before);
    const r = buildSuiteResult(dir, snapshot, false);
    expect(r.items.map((i) => [i.itemId, i.status, i.reasonCode])).toEqual([["P", "passed", "ok"], ["F", "failed", "assertion-failed"], ["N", "not-executed", "legacy-unknown"], ["S", "failed", "assertion-failed"]]);
    expect(r.items.find((i) => i.itemId === "S")?.assertionModel).toBe("aggregate-v1");
    expect(r.decision).toBe("FAIL");
    expect(r.coverageGaps).toEqual([expect.objectContaining({ identity: "api-check:N", reasonCode: "legacy-unknown" })]);
    expect(readFileSync(join(dir, "check-results.json"), "utf-8")).toBe(before); // historical artifact untouched
  });

  it("a missing result is never a pass, and an auth failure marks everything not executed", () => {
    const dir = mkdtempSync(join(tmpdir(), "autoqa-suite-res-"));
    const snapshot: SuiteRunSnapshot = { schemaVersion: 1, runId: "RUN-X", profileId: "demo", suite: { id: "s", name: "S", revision: 1, contentHash: "c".repeat(64), items: [
      { kind: "workflow", id: "W", required: true, definitionHash: "a".repeat(64) }, { kind: "api-check", id: "C", required: true, definitionHash: "b".repeat(64) }] },
      target: { origin: ORIGIN, environmentKind: "owned-sandbox", authMode: "form-login", runSessionAuth: "cookie" }, executionSettings: { limits: {}, effectiveLimits: { maxActions: 1, maxDurationMs: 1, maxApiRequests: 1 }, mode: "demo" }, recordedAt: "" };
    writeFileSync(join(dir, "run-summary.json"), JSON.stringify({ status: "completed", actionsPerformed: 3, modelCalls: 1 }));
    writeFileSync(join(dir, "authentication.json"), JSON.stringify({ status: "success" }));
    const missing = buildSuiteResult(dir, snapshot, true);
    expect(missing.items.map((i) => i.status)).toEqual(["not-executed", "not-executed"]);
    expect(missing.decision).toBe("INCOMPLETE");
    writeFileSync(join(dir, "authentication.json"), JSON.stringify({ status: "failed", reason: "rejected" }));
    mkdirSync(join(dir, "workflows"));
    writeFileSync(join(dir, "workflows", "W.json"), JSON.stringify({ workflowId: "W", status: "blocked", reason: "x", evidence: { failureKind: "not-reached" } }));
    const auth = buildSuiteResult(dir, snapshot, true);
    expect(auth.authentication).toBe("failed");
    expect(auth.items.every((i) => i.status === "not-executed" && i.reason.includes("authentication did not succeed"))).toBe(true);
  });
});

const suiteResult = (items: SuiteItemResult[], over: Partial<SuiteResult> = {}): SuiteResult => ({
  schemaVersion: 1, runId: "RUN-NEW", profileId: "demo", suite: { id: "s", name: "S", revision: 1, contentHash: "c".repeat(64), items: [] },
  target: { origin: ORIGIN, environmentKind: "owned-sandbox", authMode: "form-login", runSessionAuth: "cookie" },
  executionSettings: { limits: {}, effectiveLimits: { maxActions: 1, maxDurationMs: 1, maxApiRequests: 1 }, mode: "demo" },
  runStatus: "completed", authentication: "verified", decision: "PASS", decisionReason: "", coverageGaps: [], scope: "", items,
  counts: { required: 0, optional: 0, passed: 0, failed: 0, notExecuted: 0, unsupported: 0 },
  accounting: { browserActions: 0, httpCheckRequests: 0, modelDecisions: 0, externalModelRequests: 0 }, ...over,
});
const a = (id: string, passed: boolean, itemId = "W", observed = passed ? "ok" : "bad") => ({ id, identity: `workflow:${itemId}#${id}`, assertion: id, expected: "ok", observed, passed });
const baselineFrom = (result: SuiteResult): Baseline => ({ runId: "RUN-BASE", profileId: result.profileId, suiteId: result.suite.id, suiteRevision: result.suite.revision, suiteContentHash: result.suite.contentHash, target: result.target, executionSettings: result.executionSettings, items: result.items, decision: result.decision, approvedAt: "2026-09-29T00:00:00Z", approvedBy: "local user" });

describe("comparison", () => {
  it("matches by identity (not order) and assigns every category", () => {
    const base = baselineFrom(suiteResult([
      item({ assertions: [a("url", true), a("visible", true), a("query:q", false), a("count", true), a("old", true)] }),
      item({ identity: "workflow:GONE", itemId: "GONE", assertions: [a("url", true, "GONE")] }),
      item({ identity: "workflow:SKIP", itemId: "SKIP", assertions: [a("url", true, "SKIP")] }),
      item({ identity: "workflow:CHG", itemId: "CHG", assertions: [a("url", true, "CHG")] }),
    ]));
    const now = suiteResult([
      item({ identity: "workflow:NEW", itemId: "NEW", assertions: [a("url", true, "NEW")] }),
      item({ identity: "workflow:SKIP", itemId: "SKIP", status: "not-executed", reason: "Budget." }),
      item({ identity: "workflow:CHG", itemId: "CHG", definitionHash: "f".repeat(64), assertions: [a("url", true, "CHG")] }),
      item({ status: "failed", assertions: [a("new-one", true), a("count", false), a("query:q", true), a("visible", false), a("url", true)] }),
    ]);
    const c = compareToBaseline(now, base);
    const cat = (identity: string) => c.entries.find((e) => e.identity === identity)?.category;
    expect(cat("workflow:W#url")).toBe("unchanged-passing");
    expect(cat("workflow:W#visible")).toBe("newly-failing");
    expect(cat("workflow:W#query:q")).toBe("fixed");
    expect(cat("workflow:W#count")).toBe("newly-failing");
    expect(cat("workflow:W#new-one")).toBe("added");
    expect(cat("workflow:W#old")).toBe("removed");
    expect(cat("workflow:GONE")).toBe("removed");
    expect(cat("workflow:NEW")).toBe("added");
    expect(cat("workflow:SKIP#url")).toBe("not-executed");
    expect(cat("workflow:CHG")).toBe("incomparable");
    expect(c.entries[0]!.category).toBe("newly-failing"); // new failures listed first
    expect(c.counts["newly-failing"]).toBe(2);
  });

  it("refuses whole comparisons across targets, environments, auth modes; says so when no baseline exists", () => {
    const base = baselineFrom(suiteResult([item({ assertions: [a("url", true)] })]));
    expect(compareToBaseline(suiteResult([]), undefined)).toMatchObject({ comparable: false, reason: expect.stringContaining("No approved baseline") });
    for (const [field, value, text] of [["origin", "http://other.test", "target changed"], ["environmentKind", "local-fixture", "environment changed"], ["authMode", "none", "authentication mode changed"]] as const) {
      const now = suiteResult([item({ assertions: [a("url", false)] })], { target: { ...base.target, [field]: value } });
      const c = compareToBaseline(now, base);
      expect(c).toMatchObject({ comparable: false, entries: [] });
      expect(c.reason).toContain(text);
    }
    expect(compareToBaseline(suiteResult([], { runId: "RUN-BASE" }), base).reason).toContain("is the approved baseline");
  });
});

describe("baseline approval", () => {
  function runDir(runsDir: string, runId: string, result: Partial<SuiteResult>, snapshot: Partial<SuiteRunSnapshot> = {}) {
    const dir = join(runsDir, runId); mkdirSync(dir, { recursive: true });
    const full = suiteResult([], { runId, ...result });
    writeFileSync(join(dir, "suite-run.json"), JSON.stringify({ schemaVersion: 1, runId, profileId: full.profileId, suite: full.suite, target: full.target, executionSettings: full.executionSettings, recordedAt: "", ...snapshot }));
    writeFileSync(join(dir, "suite-result.json"), JSON.stringify(full));
    return dir;
  }

  it("accepts only completed PASS runs of the same application, suite and revision; never replaces silently; keeps history", () => {
    const profilesDir = mkdtempSync(join(tmpdir(), "autoqa-bl-p-")); const runsDir = mkdtempSync(join(tmpdir(), "autoqa-bl-r-"));
    const suite = { id: "s", name: "S", description: "", revision: 1, createdAt: "", updatedAt: "", target: suiteResult([]).target, items: [], limits: {} };
    const hash = suiteContentHash(suite);
    const withHash = { suite: { id: "s", name: "S", revision: 1, contentHash: hash, items: [] } };
    runDir(runsDir, "RUN-OK", withHash);
    runDir(runsDir, "RUN-OK2", withHash);
    runDir(runsDir, "RUN-CANCEL", { ...withHash, runStatus: "cancelled", decision: "INCOMPLETE" });
    runDir(runsDir, "RUN-FAIL", { ...withHash, decision: "FAIL" });
    runDir(runsDir, "RUN-INC", { ...withHash, decision: "INCOMPLETE" });
    runDir(runsDir, "RUN-OTHER", { ...withHash, profileId: "other" });
    runDir(runsDir, "RUN-OLDREV", { suite: { ...withHash.suite, revision: 0 } }, { suite: { ...withHash.suite, revision: 0 } });
    const reason = (runId: string) => { const e = baselineEligibility(runsDir, runId, "demo", suite); return e.eligible ? "eligible" : e.reason; };
    expect(reason("RUN-OK")).toBe("eligible");
    expect(reason("RUN-CANCEL")).toContain("cancelled");
    expect(reason("RUN-FAIL")).toContain("A required item failed");
    expect(reason("RUN-INC")).toContain("coverage is incomplete");
    expect(reason("RUN-OTHER")).toContain("different application");
    expect(reason("RUN-OLDREV")).toContain("revision 0");
    expect(reason("../RUN-OK")).toBe("That run does not exist.");
    expect(reason("RUN-MISSING")).toBe("That run does not exist.");

    const before = readFileSync(join(runsDir, "RUN-OK", "suite-result.json"), "utf-8");
    approveBaseline(profilesDir, runsDir, "demo", suite, hash, "RUN-OK");
    expect(readFileSync(join(runsDir, "RUN-OK", "suite-result.json"), "utf-8")).toBe(before);
    expect(() => approveBaseline(profilesDir, runsDir, "demo", suite, hash, "RUN-OK2")).toThrow(/already has an approved baseline/);
    expect(currentBaseline(profilesDir, "demo", "s")?.runId).toBe("RUN-OK");
    approveBaseline(profilesDir, runsDir, "demo", suite, hash, "RUN-OK2", { replace: true });
    expect(loadBaselines(profilesDir, "demo").suites["s"]).toMatchObject({ current: { runId: "RUN-OK2" }, history: [{ runId: "RUN-OK" }] });
    expect(() => approveBaseline(profilesDir, runsDir, "demo", suite, "d".repeat(64), "RUN-OK", { replace: true })).toThrow(/suite changed/);
  });
});
