import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileStore } from "../src/profiles/store.js";
import { LiveModeNotConfirmedError, RunAlreadyActiveError, RunManager } from "../src/run-manager.js";
import type { RunSummary } from "../src/report.js";

const FIXTURE_LIMITS = { maxActions: 80, maxModelCalls: 60, maxPages: 10, maxFindings: 15, maxDurationMs: 300000, maxCriticCalls: 15 };

// A distinct port from qa.config.mock.yaml's 4173 (used by
// tests/reporting/assemble.test.ts) and tests/server/e2e-fixture.test.ts's
// 4193 -- each test file that spins up a real fixture server must bind a
// port no other concurrently-running file also binds, or Vitest's
// parallel test-file execution collides on EADDRINUSE (same class of bug
// fixed for tests/validator.test.ts/tests/safety/navigation-guard.test.ts
// in Milestone 0; those two now use OS-assigned ports since a single
// literal fixture-server port is baked into every profile/config that
// uses it here, ephemeral-izing it would require deeper runPipeline()
// plumbing this milestone didn't need).
function makeProfileStore(): ProfileStore {
  const dir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-profiles-"));
  writeFileSync(
    join(dir, "fixture.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "fixture",
      name: "Test Fixture",
      target: { url: "http://localhost:4183/", environmentKind: "local-fixture" },
      navigation: { allowedOrigins: ["http://localhost:4183"], allowedPathPrefixes: ["/"] },
      resources: { allowedApiOrigins: ["http://localhost:4183"], allowedFormSubmitEndpoints: [] },
      workflows: { allowedWorkflowKinds: ["navigate", "search", "filter", "sort", "paginate"] },
      auth: { mode: "none" },
      provider: {
        explorer: { provider: "mock" },
        critic: { enabled: true, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
        providerTimeoutMs: 30000,
      },
      limits: FIXTURE_LIMITS,
    }),
    "utf-8"
  );
  return new ProfileStore(dir);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

let managers: RunManager[] = [];

afterEach(() => {
  // Best-effort: stop any run left active by a failed assertion so it
  // doesn't keep a browser/fixture-server process alive past this test.
  for (const m of managers) {
    const active = m.getActiveRun();
    if (active) m.stopRun(active.runId);
  }
  managers = [];
});

describe("RunManager (Phase 4 Milestone B)", () => {
  it("runs the fixture end-to-end in demo mode and produces a completed report", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-runs-"));
    const manager = new RunManager(makeProfileStore(), runsDir);
    managers.push(manager);

    const { runId } = await manager.startRun({ profileId: "fixture", mode: "demo" });
    expect(manager.getActiveRun()?.runId).toBe(runId);

    await waitUntil(() => manager.getActiveRun() === undefined, 60_000);

    const summaryPath = join(runsDir, runId, "run-summary.json");
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as RunSummary;
    expect(summary.status).toBe("completed");
    expect(summary.validatedFindings).toBeGreaterThan(0);

    const list = manager.listRuns();
    expect(list.find((r) => r.runId === runId)?.status).toBe("completed");
  }, 90_000);

  it("rejects a second startRun() while one is active", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-runs2-"));
    const manager = new RunManager(makeProfileStore(), runsDir);
    managers.push(manager);

    const { runId } = await manager.startRun({ profileId: "fixture", mode: "demo" });
    await expect(manager.startRun({ profileId: "fixture", mode: "demo" })).rejects.toBeInstanceOf(RunAlreadyActiveError);

    manager.stopRun(runId);
    await waitUntil(() => manager.getActiveRun() === undefined, 30_000);
  }, 60_000);

  it("cancellation actually stops a run and marks it cancelled, never completed", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-runs3-"));
    const manager = new RunManager(makeProfileStore(), runsDir);
    managers.push(manager);

    const { runId } = await manager.startRun({ profileId: "fixture", mode: "demo" });
    // Give the run a brief head start into real exploration before stopping it.
    await new Promise((r) => setTimeout(r, 800));
    const stopped = manager.stopRun(runId);
    expect(stopped).toBe(true);

    await waitUntil(() => manager.getActiveRun() === undefined, 30_000);

    const summaryPath = join(runsDir, runId, "run-summary.json");
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as RunSummary;
    expect(summary.status).toBe("cancelled");
    expect(summary.status).not.toBe("completed");
  }, 60_000);

  it("stopRun() on an unknown/already-finished runId returns false (nothing to stop)", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-runs4-"));
    const manager = new RunManager(makeProfileStore(), runsDir);
    managers.push(manager);
    expect(manager.stopRun("RUN-DOES-NOT-EXIST")).toBe(false);
  });

  it("live mode requires confirmedLimits matching the profile's own limits", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-runs5-"));
    const manager = new RunManager(makeProfileStore(), runsDir);
    managers.push(manager);

    await expect(manager.startRun({ profileId: "fixture", mode: "live" })).rejects.toBeInstanceOf(LiveModeNotConfirmedError);
    await expect(
      manager.startRun({ profileId: "fixture", mode: "live", confirmedLimits: { ...FIXTURE_LIMITS, maxActions: 999 } })
    ).rejects.toBeInstanceOf(LiveModeNotConfirmedError);
  });

  it("listRuns() relabels a run directory with no summary as interrupted, rather than omitting it", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-runs6-"));
    mkdirSync(join(runsDir, "RUN-ORPHANED"), { recursive: true });
    const manager = new RunManager(makeProfileStore(), runsDir);
    managers.push(manager);

    const list = manager.listRuns();
    expect(list.find((r) => r.runId === "RUN-ORPHANED")?.status).toBe("interrupted");
  });
});
