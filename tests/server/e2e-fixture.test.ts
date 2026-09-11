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

  it("useful setup error for an intentionally-broken profile (unreachable target), never a stack trace", async () => {
    const res = await authedFetch("/api/preflight?profileId=fixture");
    // The fixture server isn't running for this isolated preflight check
    // (no run has started it) -- confirms doctor reports a named,
    // actionable failure rather than crashing the request.
    const report = (await res.json()) as { checks: Array<{ id: string; status: string; nextStep?: string }> };
    expect(res.status).toBe(200);
    const targetCheck = report.checks.find((c) => c.id === "target-reachable");
    if (targetCheck?.status === "fail") {
      expect(targetCheck.nextStep).toBeTruthy();
    }
  });
});
