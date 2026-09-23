import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileStore } from "../../src/profiles/store.js";
import { RunAlreadyActiveError, RunManager } from "../../src/run-manager.js";

/**
 * 2026-09-23 fix: RunManager.startRun() used to be racy against
 * auth-discovery's own lock -- src/server/app.ts checked
 * isAuthDiscoveryActive() *before* awaiting the request body, while
 * startRun()'s own check-and-set of `this.starting` ran only afterward.
 * A discovery request arriving in that window could acquire its lock
 * concurrently with a run starting. The fix folds isAuthDiscoveryActive()
 * into startRun()'s own synchronous prelude (see run-manager.ts's
 * 2026-09-14/2026-09-23 doc comments). This test proves that ordering
 * directly and deterministically, without spinning up a real browser for
 * discovery: it mocks isAuthDiscoveryActive() to report "active" and
 * asserts startRun() rejects *before* ever touching the profile store or
 * setting its own `starting` lock -- i.e. the check genuinely happens
 * first, synchronously, not as an afterthought once other work is underway.
 */
let discoveryActive = false;
vi.mock("../../src/server/routes/auth-discovery.js", () => ({
  isAuthDiscoveryActive: () => discoveryActive,
}));

const FIXTURE_LIMITS = { maxActions: 80, maxModelCalls: 60, maxPages: 10, maxFindings: 15, maxDurationMs: 300000, maxCriticCalls: 15 };

function makeProfileStore(): ProfileStore {
  const dir = mkdtempSync(join(tmpdir(), "autoqa-toctou-profiles-"));
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

afterEach(() => { discoveryActive = false; vi.restoreAllMocks(); });

describe("RunManager.startRun() vs. auth-discovery lock (TOCTOU fix)", () => {
  it("rejects immediately when discovery is active, before loading the profile or acquiring its own lock", async () => {
    const store = makeProfileStore();
    const loadSpy = vi.spyOn(store, "load");
    discoveryActive = true;
    const manager = new RunManager(store, mkdtempSync(join(tmpdir(), "autoqa-toctou-runs-")));

    const rejection = manager.startRun({ profileId: "fixture", mode: "demo" });
    await expect(rejection).rejects.toBeInstanceOf(RunAlreadyActiveError);
    await expect(rejection).rejects.toThrow(/discovery/);

    // The rejection happened in the synchronous prelude, before the profile
    // was ever loaded -- proving the discovery check runs first, not after
    // other startRun() work has already begun.
    expect(loadSpy).not.toHaveBeenCalled();
    expect(manager.isBusy()).toBe(false);
  });

  it("proceeds normally once discovery is no longer active", async () => {
    const store = makeProfileStore();
    discoveryActive = true;
    const manager = new RunManager(store, mkdtempSync(join(tmpdir(), "autoqa-toctou-runs-")));
    await expect(manager.startRun({ profileId: "fixture", mode: "demo" })).rejects.toBeInstanceOf(RunAlreadyActiveError);

    discoveryActive = false;
    const { runId } = await manager.startRun({ profileId: "fixture", mode: "demo" });
    expect(runId).toBeTruthy();
    manager.stopRun(runId);
  });
});
