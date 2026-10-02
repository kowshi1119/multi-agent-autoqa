import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import type { ApiObservations, ObservedEndpoint } from "../../src/auth/api-observer.js";
import { buildObservedDrafts, observedSelectionSchema, proposeAssertions, type StoredObservation } from "../../src/checks/observed-drafts.js";
import { startServer } from "../../src/server/app.js";
import { saveSuite } from "../../src/suites/suite-manifest.js";
import { preparedTarget } from "../helpers/prepared-target.js";
import { runSuite, suiteEnvironment } from "../helpers/suite-env.js";

let server: AuthFixtureServer | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await server?.close(); server = undefined;
  for (const c of closers.splice(0)) await c();
});

const ORIGIN = "http://localhost:4999";
const endpoint = (patch: Partial<ObservedEndpoint>): ObservedEndpoint => ({
  origin: ORIGIN, method: "GET", pathTemplate: "/api/v1/rates/currencies", ambiguous: false, mergedDistinctPaths: false, queryNames: [], statuses: [200], contentTypes: ["application/json"],
  seenOnPages: ["/home"], observations: 2, samplesWithBody: 2, emptyArrays: [], omissions: [], fromServiceWorker: false,
  shape: { "$": { types: ["object"], seenIn: 2 }, "$.items": { types: ["array"], seenIn: 2 }, "$.items[*].code": { types: ["string"], seenIn: 2 }, "$.total": { types: ["integer"], seenIn: 2 }, "$.note": { types: ["string"], seenIn: 1 }, "$.<field#3>": { types: ["string"], seenIn: 2 } },
  ...patch,
});
const stored = (endpoints: ObservedEndpoint[], profileId = "demo"): StoredObservation => ({ sha256: "a".repeat(64), observations: { schemaVersion: 2, runId: "RUN-20261001-000000000Z-abcd", profileId, endpoints } as unknown as ApiObservations & { runId: string; profileId: string } });
const select = (patch: Record<string, unknown> = {}) => observedSelectionSchema.parse({ origin: ORIGIN, method: "GET", pathTemplate: "/api/v1/rates/currencies", assertions: { status: true, contentType: true, shape: ["items", "total"] }, ...patch });
const inScope = () => true;

describe("observation drafts (pure)", () => {
  it("proposes only observed facts and keeps facts, proposals and the official contract apart", () => {
    const [draft] = buildObservedDrafts(stored([endpoint({})]), "demo", ORIGIN, [select()], inScope);
    expect(draft).toMatchObject({ executable: true, evidence: "structure-only", officialContract: null, authMode: "run-session" });
    expect(draft!.check).toMatchObject({ method: "GET", pathname: "/api/v1/rates/currencies", evidence: "structure-only", assertions: { expectedStatus: 200, expectedContentType: "application/json", shape: { items: "array", total: "number" } } });
    expect(draft!.check!.assertions.requiredFields).toBeUndefined();
    const ids = proposeAssertions(endpoint({})).map((p) => p.id);
    // Not in every sample, inside an array, or masked: never proposed.
    expect(ids).not.toContain("shape:note");
    expect(ids.some((id) => id.includes("[*]") || id.includes("<"))).toBe(false);
    expect(draft!.limitations.join(" ")).toContain("not thereby shown to be free of side effects");
  });

  it("refuses masked, parameterised, other-origin, out-of-scope and unobserved selections", () => {
    const reasons = (e: ObservedEndpoint, s = select(), scope = inScope) => buildObservedDrafts(stored([e]), "demo", ORIGIN, [s], scope)[0]!.problems.join(" ");
    expect(reasons(endpoint({ pathTemplate: "/api/v1/users/{seg}/profile", ambiguous: true }), select({ pathTemplate: "/api/v1/users/{seg}/profile" }))).toContain("masked");
    expect(reasons(endpoint({ pathTemplate: "/api/v1/accounts/{id}" }), select({ pathTemplate: "/api/v1/accounts/{id}" }))).toContain("never recorded");
    expect(reasons(endpoint({ origin: "http://localhost:5000" }), select({ origin: "http://localhost:5000" }))).toContain("only to the application's own origin");
    expect(reasons(endpoint({}), select(), () => false)).toContain("outside the application's allowed path prefixes");
    expect(reasons(endpoint({}), select({ assertions: { shape: ["note"] } }))).toContain("not an observed fact");
    expect(reasons(endpoint({}), select({ assertions: {} }))).toContain("at least one assertion");
    expect(reasons(endpoint({ statuses: [200, 304] }), select({ assertions: { status: true } }))).toContain("single successful status");
  });

  it("requires explicit non-secret values for observed query parameters", () => {
    const e = endpoint({ queryNames: ["sourceCurrency"] });
    expect(buildObservedDrafts(stored([e]), "demo", ORIGIN, [select()], inScope)[0]!.problems.join(" ")).toContain('explicit, non-secret test value for query parameter "sourceCurrency"');
    expect(buildObservedDrafts(stored([e]), "demo", ORIGIN, [select({ query: { sourceCurrency: "XXX" } })], inScope)[0]!.check!.query).toEqual({ sourceCurrency: "XXX" });
    expect(buildObservedDrafts(stored([endpoint({ queryNames: ["<param#0>"] })]), "demo", ORIGIN, [select()], inScope)[0]!.problems.join(" ")).toContain("masked");
    expect(buildObservedDrafts(stored([endpoint({ queryNames: ["sessionToken"] })]), "demo", ORIGIN, [select({ query: { sessionToken: "x" } })], inScope)[0]!.problems.join(" ")).toContain("credential-bearing");
    expect(buildObservedDrafts(stored([e]), "demo", ORIGIN, [select({ query: { sourceCurrency: "XXX", extra: "1" } })], inScope)[0]!.problems.join(" ")).toContain("was not observed");
  });

  it("offers only status and media type for a metadata-only endpoint, and rejects another application's observation", () => {
    const metadataOnly = endpoint({ samplesWithBody: 0, shape: {}, omissions: [{ reason: "body-size-unknown-compressed", count: 2 }] });
    expect(proposeAssertions(metadataOnly).map((p) => p.id)).toEqual(["status", "content-type"]);
    expect(buildObservedDrafts(stored([metadataOnly]), "demo", ORIGIN, [select({ assertions: { status: true } })], inScope)[0]!.completeness).toContain("Metadata only");
    expect(() => buildObservedDrafts(stored([endpoint({})], "other"), "demo", ORIGIN, [select()], inScope)).toThrow("different application");
  });
});

describe("observation → draft → approval → structure-only check (local UI server, synthetic fixture)", () => {
  it("drafts without contacting the application, revalidates on approval, and runs the approved check without storing values", async () => {
    server = await startAuthFixtureServer({ statementListApi: "client" });
    const env = suiteEnvironment(server.origin, { apiChecks: [], securityChecks: [] });
    env.writeProfile({ apiChecks: { enabled: false, allowedMutatingEndpoints: [], responseSizeCapBytes: 65536, useRunSession: false } });
    saveSuite(env.store, "demo", { id: "wf", name: "Workflow", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }], limits: {} });
    const runA = await runSuite(env, "wf");
    const ui = await startServer({ port: 0, profilesDir: env.profilesDir, runsDir: env.runsDir });
    closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
    const base = `http://127.0.0.1:${ui.port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": ui.csrfToken }, body: JSON.stringify(body) });

    const observed = await (await fetch(`${base}/api/profiles/demo/runs/${runA.runId}/api-observations`)).json() as { observation: ApiObservations; observationSha256: string };
    const list = observed.observation.endpoints.find((e) => e.pathTemplate === "/api/statement-list")!;
    expect(list).toMatchObject({ queryNames: ["page", "pageSize"], statuses: [200] });
    const hitsBefore = server.requestLog.length;
    const selection = { origin: server.origin, method: "GET", pathTemplate: "/api/statement-list", query: { page: "1", pageSize: "5" }, assertions: { status: true, contentType: true, shape: ["items", "total"] } };
    const drafted = await (await post("/api/profiles/demo/api-drafts", { runId: runA.runId, selections: [selection] })).json() as { drafts: Array<{ executable: boolean; problems: string[] }>; observationSha256: string };
    expect(drafted.drafts[0]).toMatchObject({ executable: true, problems: [] });
    expect(server.requestLog.length).toBe(hitsBefore);

    const before = readFileSync(join(env.profilesDir, "demo.checks.json"), "utf-8");
    const expected = await preparedTarget(base, "demo"); // "Check setup" itself probes the target once
    const afterSetup = server.requestLog.length;
    const approve = (patch: Record<string, unknown>) => post("/api/profiles/demo/api-drafts/approve", { runId: runA.runId, selections: [selection], observationSha256: drafted.observationSha256, expected, ...patch });
    expect((await approve({ observationSha256: "0".repeat(64) })).status).toBe(409); // stale or tampered observation
    expect((await approve({ expected: { ...expected, fingerprint: "0".repeat(64) } })).status).toBe(409); // target changed
    expect((await approve({ selections: [{ ...selection, assertions: { shape: ["items[*].status"] } }] })).status).toBe(422); // not an observed fact
    // Another application's observation: same file contents, different profile.
    const foreign = `${runA.runId.slice(0, -4)}ffff`;
    cpSync(join(env.runsDir, runA.runId), join(env.runsDir, foreign), { recursive: true });
    const foreignPath = join(env.runsDir, foreign, "api-observations.json");
    writeFileSync(foreignPath, readFileSync(foreignPath, "utf-8").replace('"profileId": "demo"', '"profileId": "other"'));
    expect((await post("/api/profiles/demo/api-drafts", { runId: foreign, selections: [selection] })).status).toBe(409);
    expect(readFileSync(join(env.profilesDir, "demo.checks.json"), "utf-8")).toBe(before);
    expect(server.requestLog.length).toBe(afterSetup);

    const ok = await (await approve({ enableApiChecks: true })).json() as { saved: string[]; apiChecksEnabled: boolean };
    expect(ok).toEqual({ saved: ["OBS-api-statement-list"], apiChecksEnabled: true });
    expect(env.store.load("demo").apiChecks).toMatchObject({ enabled: true, useRunSession: true });

    saveSuite(env.store, "demo", { id: "api", name: "API", description: "", items: [{ kind: "api-check", id: "OBS-api-statement-list", required: true }], limits: {} });
    const runB = await runSuite(env, "api");
    expect(runB.result.decision).toBe("PASS");
    const evidence = readFileSync(join(runB.dir, "checks", "OBS-api-statement-list", "response.json"), "utf-8");
    expect(JSON.parse(evidence)).toMatchObject({ evidence: "structure-only", status: 200, contentType: "application/json", bodyRecorded: false });
    for (const value of ["Book Nook", "Coffee House", "st-01", "pending"]) expect(evidence).not.toContain(value);
  }, 240_000);
});
