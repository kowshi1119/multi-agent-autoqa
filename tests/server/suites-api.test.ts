import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { startServer } from "../../src/server/app.js";
import { credentials, suiteEnvironment } from "../helpers/suite-env.js";
import { preparedTarget } from "../helpers/prepared-target.js";

let server: AuthFixtureServer | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await server?.close(); server = undefined;
  for (const close of closers.splice(0)) await close();
});

async function setup() {
  server = await startAuthFixtureServer();
  const env = suiteEnvironment(server.origin);
  const ui = await startServer({ port: 0, profilesDir: env.profilesDir, runsDir: env.runsDir });
  closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
  const base = `http://127.0.0.1:${ui.port}`;
  const post = (path: string, body: unknown, csrf = true) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": ui.csrfToken } : {}) }, body: JSON.stringify(body) });
  const totalHits = () => [...server!.hits.values()].reduce((a, b) => a + b, 0);
  const waitIdle = async () => { for (let i = 0; i < 1000; i++) { const d = await (await fetch(base + "/api/runs")).json() as { activeRun: unknown }; if (!d.activeRun) return; await new Promise((r) => setTimeout(r, 100)); } };
  return { env, base, post, totalHits, waitIdle };
}

const smoke = { id: "smoke", name: "Smoke", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }, { kind: "api-check", id: "ME", required: true }], limits: {} };

describe("suites HTTP API", () => {
  it("saves suites only for the prepared target, refuses stale or mismatched runs with zero requests, and gates baseline approval", async () => {
    const { env, base, post, totalHits, waitIdle } = await setup();
    const listed = await (await fetch(`${base}/api/profiles/demo/suites`)).json() as { suites: unknown[]; availableItems: Array<{ id: string; kind: string; note?: string }> };
    expect(listed.suites).toEqual([]);
    expect(listed.availableItems.map((i) => i.id).sort()).toEqual(["HEADERS", "ME", "OPEN-STATEMENTS", "TRANSFER"]);
    expect(listed.availableItems.find((i) => i.id === "TRANSFER")?.note).toContain("never sent");

    const stale = { fingerprint: "0".repeat(64), origin: server!.origin };
    expect((await post("/api/profiles/demo/suites", { suite: smoke, expected: stale })).status).toBe(409);
    expect((await post("/api/profiles/demo/suites", { suite: smoke, expected: await preparedTarget(base, "demo") }, false)).status).toBe(403);
    const saved = await post("/api/profiles/demo/suites", { suite: smoke, expected: await preparedTarget(base, "demo") });
    expect(saved.status).toBe(200);
    expect((await saved.json() as { suite: { revision: number } }).suite.revision).toBe(1);
    const invalid = await post("/api/profiles/demo/suites", { suite: { ...smoke, id: "bad", items: [{ kind: "workflow", id: "NOPE", required: true }] }, expected: await preparedTarget(base, "demo") });
    expect(invalid.status).toBe(400);

    // Readiness itself probes the target, so prepare first, then count.
    const prepared = await preparedTarget(base, "demo");
    const hits0 = totalHits();
    const mismatch = await post("/api/runs", { profileId: "demo", mode: "demo", credentials, suiteId: "smoke", expected: stale });
    expect(mismatch.status).toBe(409);
    const unknown = await post("/api/runs", { profileId: "demo", mode: "demo", credentials, suiteId: "missing", expected: prepared });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { code: string }).code).toBe("SUITE_INVALID");
    const mixed = await post("/api/runs", { profileId: "demo", mode: "demo", credentials, suiteId: "smoke", workflowIds: ["OPEN-STATEMENTS"], expected: prepared });
    expect(mixed.status).toBe(400);
    expect(totalHits()).toBe(hits0);

    const expected = await preparedTarget(base, "demo");
    const [first, second] = await Promise.all([
      post("/api/runs", { profileId: "demo", mode: "demo", credentials, suiteId: "smoke", expected }),
      post("/api/runs", { profileId: "demo", mode: "demo", credentials, suiteId: "smoke", expected }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const { runId } = await (first.status === 200 ? first : second).json() as { runId: string };
    await waitIdle();
    const view = await (await fetch(`${base}/api/runs/${runId}/suite`)).json() as { result: { decision: string }; comparison: { comparable: boolean }; baselineEligibility: { eligible: boolean; replaceRequired: boolean } };
    expect(view.result.decision).toBe("PASS");
    expect(view.baselineEligibility).toMatchObject({ eligible: true, replaceRequired: false });
    expect((await post(`/api/runs/${runId}/baseline`, { suiteId: "smoke" }, false)).status).toBe(403);
    expect((await post(`/api/runs/${runId}/baseline`, { suiteId: "smoke" })).status).toBe(200);
    const again = await post(`/api/runs/${runId}/baseline`, { suiteId: "smoke" });
    expect(again.status).toBe(409);

    const secondRun = await post("/api/runs", { profileId: "demo", mode: "demo", credentials, suiteId: "smoke", expected: await preparedTarget(base, "demo") });
    const run2 = (await secondRun.json() as { runId: string }).runId;
    await waitIdle();
    const view2 = await (await fetch(`${base}/api/runs/${run2}/suite`)).json() as { comparison: { comparable: boolean; baseline: { runId: string } }; baselineEligibility: { eligible: boolean; replaceRequired: boolean } };
    expect(view2.comparison).toMatchObject({ comparable: true, baseline: { runId } });
    expect(view2.baselineEligibility).toMatchObject({ eligible: true, replaceRequired: true });
    const noReplace = await post(`/api/runs/${run2}/baseline`, { suiteId: "smoke" });
    expect(noReplace.status).toBe(409);
    expect((await noReplace.json() as { error: string }).error).toContain("Confirm replacement");
    expect((await post(`/api/runs/${run2}/baseline`, { suiteId: "smoke", replace: true })).status).toBe(200);

    expect((await fetch(`${base}/api/runs/..%2F..%2Fprofiles/suite`)).status).toBe(404);
    expect((await post(`/api/runs/${run2}/baseline`, { suiteId: "../x" })).status).toBe(400);
    const listedAfter = await (await fetch(`${base}/api/profiles/demo/suites`)).json() as { suites: Array<{ baseline: { runId: string }; baselineHistory: Array<{ runId: string }> }> };
    expect(listedAfter.suites[0]).toMatchObject({ baseline: { runId: run2 }, baselineHistory: [{ runId }] });
    void env;
  }, 240_000);
});
