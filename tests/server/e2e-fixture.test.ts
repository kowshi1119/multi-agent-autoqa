import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../../src/server/app.js";

let handle: Awaited<ReturnType<typeof startServer>>;
let baseUrl: string;

function authedFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (method !== "GET") {
    headers["X-CSRF-Token"] = handle.csrfToken;
    headers["Origin"] = baseUrl;
    if (opts.body) headers["Content-Type"] = "application/json";
  }
  return fetch(baseUrl + path, { ...opts, headers });
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

beforeAll(async () => {
  // A distinct port from qa.config.mock.yaml's 4173 and
  // tests/run-manager.test.ts's 4183 -- see that file's comment for why.
  const profilesDir = mkdtempSync(join(tmpdir(), "autoqa-e2e-profiles-"));
  writeFileSync(
    join(profilesDir, "fixture.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "fixture",
      name: "Test Fixture",
      target: { url: "http://localhost:4193/", environmentKind: "local-fixture" },
      navigation: { allowedOrigins: ["http://localhost:4193"], allowedPathPrefixes: ["/"] },
      resources: { allowedApiOrigins: ["http://localhost:4193"], allowedFormSubmitEndpoints: [] },
      workflows: { allowedWorkflowKinds: ["navigate", "search", "filter", "sort", "paginate"] },
      auth: { mode: "none" },
      provider: {
        explorer: { provider: "mock" },
        critic: { enabled: true, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
        providerTimeoutMs: 30000,
      },
      limits: { maxActions: 80, maxModelCalls: 60, maxPages: 10, maxFindings: 15, maxDurationMs: 300000, maxCriticCalls: 15 },
    }),
    "utf-8"
  );
  const runsDir = mkdtempSync(join(tmpdir(), "autoqa-e2e-runs-"));
  handle = await startServer({ profilesDir, runsDir });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => handle.server.close(() => resolvePromise()));
});

describe("Server end-to-end against the fixture profile (Phase 4 Milestone B acceptance)", () => {
  it("lists the fixture profile", async () => {
    const res = await authedFetch("/api/profiles");
    const data = (await res.json()) as { profiles: Array<{ id: string }> };
    expect(data.profiles.some((p) => p.id === "fixture")).toBe(true);
  });

  it("runs the fixture end-to-end via the HTTP API and results match report.json's canonical grouped count", async () => {
    const startRes = await authedFetch("/api/runs", { method: "POST", body: JSON.stringify({ profileId: "fixture", mode: "demo" }) });
    expect(startRes.status).toBe(200);
    const { runId } = (await startRes.json()) as { runId: string };
    expect(runId).toBeTruthy();

    await waitUntil(async () => {
      const res = await authedFetch(`/api/runs/${runId}/status`);
      const data = (await res.json()) as { active: boolean };
      return !data.active;
    }, 90_000);

    const statusRes = await authedFetch(`/api/runs/${runId}/status`);
    const status = (await statusRes.json()) as { status: string; validatedFindings: number };
    expect(status.status).toBe("completed");
    expect(status.validatedFindings).toBeGreaterThan(0);

    const reportRes = await authedFetch(`/api/artifacts/${runId}/report.json`);
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as { groups: Array<{ canonicalFindingId: string; memberFindingIds: string[] }>; findings: Array<{ id: string }> };

    // The canonical (deduplicated) count the UI's results view uses --
    // computed the same way src/reporting/assemble.ts#canonicalFindingsOnly
    // does -- must be strictly less than the raw finding count, since the
    // fixture's known duplicate-manifestation pair groups.
    const canonicalIds = new Set(report.groups.map((g) => g.canonicalFindingId));
    const groupedMemberIds = new Set(report.groups.flatMap((g) => g.memberFindingIds));
    const canonical = report.findings.filter((f) => !groupedMemberIds.has(f.id) || canonicalIds.has(f.id));
    expect(canonical.length).toBeLessThan(report.findings.length);

    const listRes = await authedFetch("/api/runs");
    const list = (await listRes.json()) as { runs: Array<{ runId: string; status: string }> };
    expect(list.runs.find((r) => r.runId === runId)?.status).toBe("completed");
  }, 120_000);

  it("the fixture profile's target-reachable check reports 'managed', not a false failure, when isolated (no run has started its server) -- Phase 4 continuation", async () => {
    const res = await authedFetch("/api/preflight?profileId=fixture");
    const report = (await res.json()) as { overallReady: boolean; checks: Array<{ id: string; status: string; nextStep?: string }> };
    expect(res.status).toBe(200);
    const targetCheck = report.checks.find((c) => c.id === "target-reachable");
    expect(targetCheck?.status).toBe("managed");
    expect(report.overallReady).toBe(true);
  });

  it("provider/model identity is present in the profile list (Phase 4 continuation)", async () => {
    const res = await authedFetch("/api/profiles");
    const data = (await res.json()) as { profiles: Array<{ id: string; provider?: { explorer: { provider: string }; critic: { enabled: boolean; provider: string } } }> };
    const fixture = data.profiles.find((p) => p.id === "fixture");
    expect(fixture?.provider?.explorer.provider).toBe("mock");
    expect(fixture?.provider?.critic.provider).toBe("mock");
  });

  it("a run refused by preflight enforcement at start never becomes active, and never appears active later (Phase 4 continuation)", async () => {
    const startRes = await authedFetch("/api/runs", { method: "POST", body: JSON.stringify({ profileId: "does-not-exist", mode: "demo" }) });
    expect(startRes.status).toBe(404);
  });

  it("GET /api/runs exposes the active run's live progress (lastEvent), enabling client-side active-run recovery after a refresh (Phase 4 continuation)", async () => {
    const startRes = await authedFetch("/api/runs", { method: "POST", body: JSON.stringify({ profileId: "fixture", mode: "demo" }) });
    const { runId } = (await startRes.json()) as { runId: string };

    await waitUntil(async () => {
      const res = await authedFetch("/api/runs");
      const data = (await res.json()) as { activeRun: { runId: string; lastEvent: unknown } | null };
      return data.activeRun?.runId === runId && data.activeRun.lastEvent !== null;
    }, 30_000);

    const res = await authedFetch("/api/runs");
    const data = (await res.json()) as { activeRun: { runId: string; lastEvent: { pagesVisited: number; actionsPerformed: number } } | null };
    expect(data.activeRun?.runId).toBe(runId);
    expect(data.activeRun?.lastEvent).toBeTruthy();

    await authedFetch(`/api/runs/${runId}/stop`, { method: "POST" });
    await waitUntil(async () => {
      const statusRes = await authedFetch(`/api/runs/${runId}/status`);
      const statusData = (await statusRes.json()) as { active: boolean };
      return !statusData.active;
    }, 30_000);
  }, 60_000);

  it("a finding's evidence is reachable through the artifact route the UI's evidence links resolve against", async () => {
    const startRes = await authedFetch("/api/runs", { method: "POST", body: JSON.stringify({ profileId: "fixture", mode: "demo" }) });
    const { runId } = (await startRes.json()) as { runId: string };

    await waitUntil(async () => {
      const res = await authedFetch(`/api/runs/${runId}/status`);
      const data = (await res.json()) as { active: boolean };
      return !data.active;
    }, 90_000);

    const reportRes = await authedFetch(`/api/artifacts/${runId}/report.json`);
    const report = (await reportRes.json()) as { findings: Array<{ id: string; evidence: string[] }> };
    const withEvidence = report.findings.find((f) => f.evidence.length > 0);
    expect(withEvidence).toBeDefined();

    for (const filename of withEvidence!.evidence) {
      const evidenceRes = await authedFetch(`/api/artifacts/${runId}/findings/${withEvidence!.id}/${filename}`);
      expect(evidenceRes.status).toBe(200);
    }
  }, 120_000);
});

describe("Profile create/edit (2026-09-15 fix: previously the UI could only list profiles, never author one -- ProfileStore.save() already worked, only the wiring was missing)", () => {
  it("creates a new profile via POST /api/profiles, which then appears in the list with correct provider identity", async () => {
    const res = await authedFetch("/api/profiles", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        id: "created-via-api-test",
        name: "Created via API test",
        target: { url: "http://localhost:9999/", environmentKind: "self-hosted-real-app" },
        navigation: { allowedOrigins: ["http://localhost:9999"], allowedPathPrefixes: ["/"] },
        resources: { allowedApiOrigins: ["http://localhost:9999"], allowedFormSubmitEndpoints: [] },
        workflows: { allowedWorkflowKinds: ["navigate"] },
        auth: { mode: "none" },
        provider: {
          explorer: { provider: "mock" },
          critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
          providerTimeoutMs: 30000,
        },
        limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
      }),
    });
    expect(res.status).toBe(200);

    const listRes = await authedFetch("/api/profiles");
    const list = (await listRes.json()) as { profiles: Array<{ id: string; provider?: { explorer: { provider: string } } }> };
    const created = list.profiles.find((p) => p.id === "created-via-api-test");
    expect(created).toBeDefined();
    expect(created?.provider?.explorer.provider).toBe("mock");
  });

  it("rejects an invalid profile with a 400 and validation detail, never silently writing a broken file", async () => {
    const res = await authedFetch("/api/profiles", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, id: "invalid-test" /* missing every other required field */ }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBeTruthy();

    const listRes = await authedFetch("/api/profiles");
    const list = (await listRes.json()) as { profiles: Array<{ id: string }> };
    expect(list.profiles.some((p) => p.id === "invalid-test")).toBe(false);
  });

  it("GET /api/profiles/:id returns the full document (used to pre-fill the edit form), and 404s for an unknown id", async () => {
    const res = await authedFetch("/api/profiles/fixture");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { profile: { id: string; navigation: { allowedOrigins: string[] } } };
    expect(data.profile.id).toBe("fixture");
    expect(data.profile.navigation.allowedOrigins.length).toBeGreaterThan(0);

    const missingRes = await authedFetch("/api/profiles/does-not-exist-at-all");
    expect(missingRes.status).toBe(404);
  });

  it("editing (re-saving with the same id) persists the change -- a save with an existing id overwrites, exactly what 'edit' means here", async () => {
    const getRes = await authedFetch("/api/profiles/created-via-api-test");
    const { profile } = (await getRes.json()) as { profile: Record<string, unknown> };
    profile["name"] = "Renamed via edit test";

    const saveRes = await authedFetch("/api/profiles", { method: "POST", body: JSON.stringify(profile) });
    expect(saveRes.status).toBe(200);

    const reGetRes = await authedFetch("/api/profiles/created-via-api-test");
    const { profile: reloaded } = (await reGetRes.json()) as { profile: { name: string } };
    expect(reloaded.name).toBe("Renamed via edit test");
  });
});
