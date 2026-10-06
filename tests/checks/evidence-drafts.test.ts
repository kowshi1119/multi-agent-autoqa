import { createHash } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import type { ApiObservations } from "../../src/auth/api-observer.js";
import { buildEvidenceDrafts, type StoredEvidence } from "../../src/checks/evidence-drafts.js";
import type { DeclaredApiCheck } from "../../src/checks/checks-manifest.js";
import { startServer } from "../../src/server/app.js";
import { checkDefinitionHash, saveSuite } from "../../src/suites/suite-manifest.js";
import { preparedTarget } from "../helpers/prepared-target.js";
import { runSuite, suiteEnvironment } from "../helpers/suite-env.js";

let server: AuthFixtureServer | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await server?.close(); server = undefined;
  for (const c of closers.splice(0)) await c();
});

const CHECK: DeclaredApiCheck = { id: "LIST", method: "GET", pathname: "/api/list", description: "List", evidence: "structure-only", assertions: { expectedStatus: 200, invariants: [] } };
const stored = (patch: Record<string, unknown> = {}): StoredEvidence => ({
  runId: "RUN-20261006-000000000Z-abcd", checkId: "LIST", sha256: "e".repeat(64), entry: { checkId: "LIST", kind: "api", ran: true, classification: "passed", assertion: "", observation: "", evidenceRefs: [] },
  evidence: { evidence: "structure-only", profileId: "demo", origin: "http://localhost:1", checkId: "LIST", checkDefinitionHash: checkDefinitionHash(CHECK), status: 200, contentType: "application/json", bodyRecorded: false,
    bodyShape: { "$": ["object"], "$.items": ["array"], "$.total": ["integer"], "$.flag": ["boolean"], "$.mixed": ["null", "string"], "$.<field#4>": ["string"], "$.meta.page": ["integer"] }, emptyArrays: ["$.items"], shapeOmissions: [], ...patch },
});

describe("stage-B proposals (pure)", () => {
  it("proposes only named top-level fields with one type, and states single-sample and empty-array limits", () => {
    const drafts = buildEvidenceDrafts(stored(), "demo", "http://localhost:1", CHECK);
    expect(drafts.proposals.map((p) => [p.field, p.expected])).toEqual([["items", "array"], ["total", "number"], ["flag", "boolean"]]);
    expect(drafts.proposals[0]!.provenance).toContain("1/1 executed response");
    expect(drafts.observedFacts.emptyArrays).toEqual(["$.items"]);
    expect(drafts.limitations.join(" ")).toContain("single sample");
  });

  it("refuses other applications, other origins, stale definitions, removed checks and mismatched identities", () => {
    expect(() => buildEvidenceDrafts(stored({ profileId: "other" }), "demo", "http://localhost:1", CHECK)).toThrow("different application");
    expect(() => buildEvidenceDrafts(stored(), "demo", "http://localhost:2", CHECK)).toThrow("different origin");
    expect(() => buildEvidenceDrafts(stored(), "demo", "http://localhost:1", { ...CHECK, assertions: { ...CHECK.assertions, expectedStatus: 201 } })).toThrow("stale");
    expect(() => buildEvidenceDrafts(stored(), "demo", "http://localhost:1", undefined)).toThrow("no longer an approved check");
    expect(() => buildEvidenceDrafts(stored({ checkId: "OTHER" }), "demo", "http://localhost:1", CHECK)).toThrow("ambiguous");
  });
});

describe("compressed API: metadata-only observation → approved check → executed evidence → reviewed shape assertions", () => {
  it("adds structural assertions from an executed check without sending a request, and the suite must be re-saved", async () => {
    server = await startAuthFixtureServer({ statementListApi: "client", compressApi: true });
    const env = suiteEnvironment(server.origin, { apiChecks: [], securityChecks: [] });
    env.writeProfile({ apiChecks: { enabled: false, allowedMutatingEndpoints: [], responseSizeCapBytes: 65536, useRunSession: false } });
    saveSuite(env.store, "demo", { id: "wf", name: "Workflow", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }], limits: {} });
    const observed = await runSuite(env, "wf");
    const observation = JSON.parse(readFileSync(join(observed.dir, "api-observations.json"), "utf-8")) as ApiObservations;
    const list = observation.endpoints.find((e) => e.pathTemplate === "/api/statement-list")!;
    // Stage A: compressed, so the passive observer recorded metadata only.
    expect(list).toMatchObject({ samplesWithBody: 0, shape: {}, omissions: [{ reason: "body-size-unknown-compressed", count: 1 }] });

    const ui = await startServer({ port: 0, profilesDir: env.profilesDir, runsDir: env.runsDir });
    closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
    const base = `http://127.0.0.1:${ui.port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": ui.csrfToken }, body: JSON.stringify(body) });
    const sha = ((await (await fetch(`${base}/api/profiles/demo/runs/${observed.runId}/api-observations`)).json()) as { observationSha256: string }).observationSha256;
    const selection = { origin: server.origin, method: "GET", pathTemplate: "/api/statement-list", query: { page: "1", pageSize: "5" }, assertions: { status: true, contentType: true } };
    const approved = await post("/api/profiles/demo/api-drafts/approve", { runId: observed.runId, selections: [selection], observationSha256: sha, expected: await preparedTarget(base, "demo"), enableApiChecks: true });
    expect(approved.status).toBe(200);

    // The approved check executes through the bounded requester (one request, decompressed by AutoQA's own client).
    saveSuite(env.store, "demo", { id: "api", name: "API", description: "", items: [{ kind: "api-check", id: "OBS-api-statement-list", required: true }], limits: {} });
    const executed = await runSuite(env, "api");
    expect(executed.result.decision).toBe("PASS");
    expect(JSON.parse(readFileSync(join(executed.dir, "check-usage.json"), "utf-8")).requests).toBe(1);

    // Stage B: proposals from that evidence, with no request to the application.
    const before = server.requestLog.length;
    const listed = await (await fetch(`${base}/api/profiles/demo/check-evidence`)).json() as { runs: Array<{ runId: string; checkIds: string[] }> };
    expect(listed.runs).toEqual([{ runId: executed.runId, checkIds: ["OBS-api-statement-list"] }]);
    const draftRes = await post("/api/profiles/demo/check-evidence-drafts", { runId: executed.runId, checkId: "OBS-api-statement-list" });
    const { drafts } = await draftRes.json() as { drafts: { proposals: Array<{ field: string; expected: string }>; source: { evidenceSha256: string } } };
    expect(drafts.proposals.map((p) => [p.field, p.expected])).toEqual([["items", "array"], ["page", "number"], ["pageSize", "number"], ["total", "number"]]);
    expect(server.requestLog.length).toBe(before);
    const evidenceText = readFileSync(join(executed.dir, "checks", "OBS-api-statement-list", "response.json"), "utf-8");
    for (const value of ["Coffee House", "st-01", "pending", "2026-09-01"]) expect(evidenceText).not.toContain(value);

    // Refusals: traversal, tampering, another application.
    expect((await post("/api/profiles/demo/check-evidence-drafts", { runId: "RUN-../../x", checkId: "OBS-api-statement-list" })).status).toBe(400);
    expect((await post("/api/profiles/demo/check-evidence-drafts", { runId: executed.runId, checkId: "../checks" })).status).toBe(400);
    const tampered = `${executed.runId.slice(0, -4)}aaaa`;
    cpSync(executed.dir, join(env.runsDir, tampered), { recursive: true });
    const tamperedPath = join(env.runsDir, tampered, "checks", "OBS-api-statement-list", "response.json");
    writeFileSync(tamperedPath, readFileSync(tamperedPath, "utf-8").replace('"status": 200', '"status": 201'));
    const tamperedRes = await post("/api/profiles/demo/check-evidence-drafts", { runId: tampered, checkId: "OBS-api-statement-list" });
    expect([tamperedRes.status, ((await tamperedRes.json()) as { code: string }).code]).toEqual([409, "tampered"]);
    const foreign = `${executed.runId.slice(0, -4)}bbbb`;
    cpSync(executed.dir, join(env.runsDir, foreign), { recursive: true });
    const foreignPath = join(env.runsDir, foreign, "checks", "OBS-api-statement-list", "response.json");
    const foreignText = readFileSync(foreignPath, "utf-8").replace('"profileId": "demo"', '"profileId": "other"');
    writeFileSync(foreignPath, foreignText);
    const ledgerPath = join(env.runsDir, foreign, "check-results.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8")) as { entries: Array<{ evidenceDigests?: Record<string, string> }> };
    ledger.entries[0]!.evidenceDigests!["checks/OBS-api-statement-list/response.json"] = createHash("sha256").update(foreignText).digest("hex");
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    const foreignRes = await post("/api/profiles/demo/check-evidence-drafts", { runId: foreign, checkId: "OBS-api-statement-list" });
    expect([foreignRes.status, ((await foreignRes.json()) as { code: string }).code]).toEqual([409, "cross-profile"]);

    // Approval revalidates the digest and the target, then changes the check.
    const expected = await preparedTarget(base, "demo");
    expect((await post("/api/profiles/demo/check-evidence-drafts/approve", { runId: executed.runId, checkId: "OBS-api-statement-list", evidenceSha256: "0".repeat(64), fields: ["items"], expected })).status).toBe(409);
    expect((await post("/api/profiles/demo/check-evidence-drafts/approve", { runId: executed.runId, checkId: "OBS-api-statement-list", evidenceSha256: drafts.source.evidenceSha256, fields: ["merchant"], expected })).status).toBe(422);
    const ok = await post("/api/profiles/demo/check-evidence-drafts/approve", { runId: executed.runId, checkId: "OBS-api-statement-list", evidenceSha256: drafts.source.evidenceSha256, fields: ["items", "total"], expected });
    expect(ok.status).toBe(200);
    const checks = JSON.parse(readFileSync(join(env.profilesDir, "demo.checks.json"), "utf-8")) as { apiChecks: DeclaredApiCheck[] };
    expect(checks.apiChecks[0]!.assertions.shape).toEqual({ items: "array", total: "number" });
    // The same evidence is now stale (the definition changed), and the suite must be reviewed and saved again.
    expect((await post("/api/profiles/demo/check-evidence-drafts", { runId: executed.runId, checkId: "OBS-api-statement-list" })).status).toBe(409);
    const suites = await (await fetch(`${base}/api/profiles/demo/suites`)).json() as { suites: Array<{ id: string; valid: boolean; errors: string[] }> };
    expect(suites.suites.find((s) => s.id === "api")).toMatchObject({ valid: false });
    expect(suites.suites.find((s) => s.id === "api")!.errors.join(" ")).toContain("changed since suite revision 1");
    expect(server.requestLog.length).toBe(before + 1); // only "Check setup" probed the target
  }, 240_000);
});
