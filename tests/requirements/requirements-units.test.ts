import { describe, expect, it } from "vitest";
import { type RequirementInput, assertionCatalog, approveRequirement, exportRequirements, importRequirements, loadRequirements, RequirementError, saveRequirement, suggestRequirements } from "../../src/requirements-coverage/requirements.js";
import { computeRequirementCoverage } from "../../src/requirements-coverage/coverage.js";
import { compareToBaseline } from "../../src/suites/compare.js";
import type { SuiteItemResult, SuiteResult } from "../../src/suites/result.js";
import type { Baseline } from "../../src/suites/baselines.js";
import { suiteEnvironment } from "../helpers/suite-env.js";

const ORIGIN = "http://localhost:4988";
const input = (criteria: RequirementInput["criteria"] = [{ id: "C1", description: "Statements open", required: true, links: [{ kind: "workflow", itemId: "OPEN-STATEMENTS", assertionId: "visible" }] }]) => ({ id: "REQ-1", title: "Statements", description: "", importance: "high" as const, criteria });

describe("approved requirements", () => {
  it("saves drafts, approves explicitly with definition hashes, and re-drafts on every edit", () => {
    const env = suiteEnvironment(ORIGIN);
    const draft = saveRequirement(env.store, "demo", input());
    expect(draft).toMatchObject({ revision: 1, status: "draft", origin: "user" });
    expect(() => approveRequirement(env.store, "demo", "REQ-1", 2)).toThrow(/revision 1/);
    const approved = approveRequirement(env.store, "demo", "REQ-1", 1);
    expect(approved.status).toBe("approved");
    expect(approved.criteria[0]!.links[0]!.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    const edited = saveRequirement(env.store, "demo", input([{ id: "C1", description: "Statements open at /statements", required: true, links: [{ kind: "workflow", itemId: "OPEN-STATEMENTS", assertionId: "url" }] }]));
    expect(edited).toMatchObject({ revision: 2, status: "draft" });
    expect(env.store.list().map((p) => p.id)).toEqual(["demo"]); // the requirements file is not a profile
  });

  it("rejects links to unknown items or assertions; never invents rules in suggestions; imports as drafts", () => {
    const env = suiteEnvironment(ORIGIN);
    const errors = (fn: () => unknown) => { try { fn(); return []; } catch (e) { return (e as RequirementError).errors; } };
    expect(errors(() => saveRequirement(env.store, "demo", input([{ id: "C1", description: "x", required: true, links: [{ kind: "workflow", itemId: "NOPE", assertionId: "url" }] }]))).join(" ")).toContain("not an approved workflow or check");
    expect(errors(() => saveRequirement(env.store, "demo", input([{ id: "C1", description: "x", required: true, links: [{ kind: "api-check", itemId: "ME", assertionId: "field:balance" }] }]))).join(" ")).toContain('does not report assertion "field:balance"');
    const catalog = assertionCatalog(env.profilesDir, env.store.load("demo"));
    expect(catalog.find((i) => i.itemId === "ME")?.assertionIds).toEqual(["status", "field:id", "field:email"]);
    expect(catalog.find((i) => i.itemId === "HEADERS")?.assertionIds).toContain("header:content-security-policy");
    const suggestions = suggestRequirements(env.profilesDir, env.store.load("demo"));
    expect(suggestions.every((s) => s.criteria.every((c) => c.links.every((l) => l.assertionId === "*")))).toBe(true);
    expect(loadRequirements(env.profilesDir, "demo").requirements).toEqual([]); // suggestions are not saved
    saveRequirement(env.store, "demo", input());
    approveRequirement(env.store, "demo", "REQ-1", 1);
    const exported = exportRequirements(env.profilesDir, "demo");
    const other = suiteEnvironment(ORIGIN);
    const imported = importRequirements(other.store, "demo", exported);
    expect(imported.map((r) => [r.id, r.status, r.origin])).toEqual([["REQ-1", "draft", "imported"]]);
    expect(errors(() => importRequirements(other.store, "demo", { requirements: [{ id: "../x" }] })).length).toBeGreaterThan(0);
  });

  it("marks a criterion incomparable when its linked definition changed after approval", () => {
    const env = suiteEnvironment(ORIGIN);
    saveRequirement(env.store, "demo", input());
    const approved = approveRequirement(env.store, "demo", "REQ-1", 1);
    const item = (hash: string): SuiteItemResult => ({ identity: "workflow:OPEN-STATEMENTS", kind: "workflow", itemId: "OPEN-STATEMENTS", required: true, definitionHash: hash, status: "passed", reasonCode: "ok", reason: "", assertions: [{ id: "visible", identity: "workflow:OPEN-STATEMENTS#visible", assertion: "v", expected: "e", observed: "o", passed: true, verdict: "pass" }], evidenceRefs: [] });
    const result = (hash: string) => ({ runId: "R", suite: { id: "s", name: "s", revision: 1, contentHash: "", items: [] }, items: [item(hash)] }) as unknown as SuiteResult;
    expect(computeRequirementCoverage([approved], result(approved.criteria[0]!.links[0]!.definitionHash!)).requirements[0]!.status).toBe("passed");
    expect(computeRequirementCoverage([approved], result("f".repeat(64))).requirements[0]!.status).toBe("incomparable");
  });
});

describe("versioned security comparison", () => {
  it("does not match an aggregate (v1) security baseline against per-assertion (v2) results", () => {
    const target = { origin: ORIGIN, environmentKind: "owned-sandbox", authMode: "form-login", runSessionAuth: "cookie" as const };
    const sec = (model: "aggregate-v1" | "per-assertion-v2" | undefined): SuiteItemResult => ({ identity: "security-check:H", kind: "security-check", itemId: "H", required: false, definitionHash: "a".repeat(64), status: "failed", reason: "", evidenceRefs: [], ...(model ? { assertionModel: model } : {}),
      assertions: model === "per-assertion-v2" ? [{ id: "header:content-security-policy", identity: "security-check:H#header:content-security-policy", assertion: "csp", expected: "present", observed: "absent", passed: false, verdict: "fail" }] : [{ id: "result", identity: "security-check:H#result", assertion: "headers", expected: "headers", observed: "Missing", passed: false }] });
    const current = { schemaVersion: 2, runId: "NEW", profileId: "demo", suite: { id: "s", name: "S", revision: 1, contentHash: "", items: [] }, target, items: [sec("per-assertion-v2")], authentication: "verified" } as unknown as SuiteResult;
    const baseline = { runId: "OLD", profileId: "demo", suiteId: "s", suiteRevision: 1, target, items: [sec(undefined)], approvedAt: "" } as unknown as Baseline;
    const c = compareToBaseline(current, baseline);
    expect(c.entries).toEqual([expect.objectContaining({ identity: "security-check:H", category: "incomparable", reason: expect.stringContaining("aggregate-v1 to per-assertion-v2") })]);
  });
});
