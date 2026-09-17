import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileStore } from "../src/profiles/store.js";
import { LiveModeNotConfirmedError, PreflightFailedError, RunAlreadyActiveError, RunManager } from "../src/run-manager.js";
import type { RunSummary } from "../src/report.js";

// 2026-09-14 addendum fix regression test: forces assembleReport() to
// throw exactly once, on demand, so a test can prove RunManager's
// catch-block usage/cost reporting reflects what runPipeline() actually
// measured -- not an unconditional "zero requests" claim -- when the
// failure happens AFTER runPipeline() itself completed. Passes through to
// the real implementation for every other test in this file.
let forceAssembleReportFailureOnce = false;
vi.mock("../src/reporting/assemble.js", async () => {
  const actual = await vi.importActual<typeof import("../src/reporting/assemble.js")>("../src/reporting/assemble.js");
  return {
    ...actual,
    assembleReport: (...args: Parameters<typeof actual.assembleReport>) => {
      if (forceAssembleReportFailureOnce) {
        forceAssembleReportFailureOnce = false;
        throw new Error("FORCED_ASSEMBLE_REPORT_FAILURE_FOR_TEST");
      }
      return actual.assembleReport(...args);
    },
  };
});

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

/** A real-target profile pointed at a port nothing listens on -- preflight's target-reachable check must genuinely fail for it (unlike the fixture, whose server just isn't started yet). */
function makeUnreachableRealTargetProfileStore(): ProfileStore {
  const dir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-unreachable-profiles-"));
  writeFileSync(
    join(dir, "unreachable.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "unreachable",
      name: "Unreachable Real Target",
      target: { url: "http://localhost:1/", environmentKind: "self-hosted-real-app" },
      navigation: { allowedOrigins: ["http://localhost:1"], allowedPathPrefixes: ["/"] },
      resources: { allowedApiOrigins: ["http://localhost:1"], allowedFormSubmitEndpoints: [] },
      workflows: { allowedWorkflowKinds: ["navigate"] },
      auth: { mode: "none" },
      provider: {
        explorer: { provider: "mock" },
        critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
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
  it("emits a terminal-phase progress event ('completed') before the run finishes -- Phase 4 continuation fix (confirmed via live UI: the SSE-subscribed client never learned a run had ended without this)", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-terminal-progress-"));
    const manager = new RunManager(makeProfileStore(), runsDir);
    managers.push(manager);

    const { runId } = await manager.startRun({ profileId: "fixture", mode: "demo" });
    const phases: string[] = [];
    const unsubscribe = manager.subscribe(runId, (event) => phases.push(event.phase));

    await waitUntil(() => manager.getActiveRun() === undefined, 60_000);
    unsubscribe();

    expect(phases.length).toBeGreaterThan(0);
    expect(phases[phases.length - 1]).toBe("completed");
    // Never "exploring" (or any non-terminal phase) as the LAST event --
    // that was the exact confirmed bug: this.progress() was called
    // against the pre-transition ctx.state, so the SSE stream's final
    // message never actually signalled completion.
    expect(["completed", "stopped", "failed"]).toContain(phases[phases.length - 1]);
  }, 90_000);

  it("a user-initiated Stop also emits a terminal 'stopped' progress event, not just 'exploring' (same confirmed fix, cancellation path)", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-terminal-stop-"));
    const manager = new RunManager(makeProfileStore(), runsDir);
    managers.push(manager);

    const { runId } = await manager.startRun({ profileId: "fixture", mode: "demo" });
    const phases: string[] = [];
    const unsubscribe = manager.subscribe(runId, (event) => phases.push(event.phase));

    await new Promise((r) => setTimeout(r, 500));
    manager.stopRun(runId);

    await waitUntil(() => manager.getActiveRun() === undefined, 30_000);
    unsubscribe();

    expect(phases[phases.length - 1]).toBe("stopped");
  }, 60_000);

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

  it("two startRun() calls fired back-to-back (no await between them) race safely -- exactly one succeeds, exactly one run directory is created (2026-09-14 addendum fix: previously a genuine TOCTOU race)", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-race-"));
    const manager = new RunManager(makeProfileStore(), runsDir);
    managers.push(manager);

    // Deliberately no `await` between these -- both calls begin executing
    // startRun() before either has reserved the slot, which is exactly
    // the race window the `starting` flag must close.
    const results = await Promise.allSettled([
      manager.startRun({ profileId: "fixture", mode: "demo" }),
      manager.startRun({ profileId: "fixture", mode: "demo" }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ runId: string }> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(RunAlreadyActiveError);

    // Exactly one run directory was ever created -- no collision, no
    // orphaned second directory from a run that silently started anyway.
    const runDirs = readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(runDirs).toHaveLength(1);

    const runId = fulfilled[0]!.value.runId;
    manager.stopRun(runId);
    await waitUntil(() => manager.getActiveRun() === undefined, 30_000);
  }, 60_000);

  it("a run-summary reflects real measured usage/budget when runPipeline() completed but assembleReport() failed afterward, never an unconditional zero claim (2026-09-14 addendum fix)", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-honest-failure-"));
    const manager = new RunManager(makeProfileStore(), runsDir);
    managers.push(manager);

    forceAssembleReportFailureOnce = true;
    const { runId } = await manager.startRun({ profileId: "fixture", mode: "demo" });
    await waitUntil(() => manager.getActiveRun() === undefined, 60_000);

    const summaryPath = join(runsDir, runId, "run-summary.json");
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as RunSummary;

    expect(summary.status).toBe("failed");
    expect(summary.stopReason).toContain("FORCED_ASSEMBLE_REPORT_FAILURE_FOR_TEST");
    // The real assertion: actionsPerformed/modelCalls/budget are NOT the
    // old unconditional zeros -- runPipeline() genuinely ran the mock
    // fixture exploration before assembleReport() failed.
    expect(summary.actionsPerformed).toBeGreaterThan(0);
    expect(summary.budget.actionsUsed).toBeGreaterThan(0);
    expect(summary.usage.costDisclosure).toContain("runPipeline() completed");
  }, 90_000);

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
    // 2026-09-16: a cancelled run must still preserve what it actually did
    // and knew before Stop, not report the old unconditional-zero fallback
    // -- this run had an 800ms head start into real mock-driven exploration
    // (via the normal assembleReport() path, since runPipeline() itself
    // resolves with a CANCELLED terminal ctx rather than throwing).
    expect(summary.actionsPerformed).toBeGreaterThan(0);
    expect(summary.budget.actionsUsed).toBeGreaterThan(0);
    expect(summary.usage).toBeDefined();
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

  it("enforces preflight before starting -- an unreachable real target is refused, not silently attempted (Phase 4 continuation)", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-preflight-runs-"));
    const manager = new RunManager(makeUnreachableRealTargetProfileStore(), runsDir);
    managers.push(manager);

    await expect(manager.startRun({ profileId: "unreachable", mode: "demo" })).rejects.toBeInstanceOf(PreflightFailedError);
    // Never actually became the active run.
    expect(manager.getActiveRun()).toBeUndefined();
  }, 30_000);

  it("preflight enforcement never blocks the fixture profile on the managed target-reachable check", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-run-manager-runs7-"));
    const manager = new RunManager(makeProfileStore(), runsDir);
    managers.push(manager);

    // If the fixture's own "server not started yet" state were still
    // reported as "fail" (the confirmed gap this fix closes), this would
    // reject with PreflightFailedError instead of starting normally.
    const { runId } = await manager.startRun({ profileId: "fixture", mode: "demo" });
    expect(manager.getActiveRun()?.runId).toBe(runId);
    manager.stopRun(runId);
    await waitUntil(() => manager.getActiveRun() === undefined, 30_000);
  }, 60_000);
});
