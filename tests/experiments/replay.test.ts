import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureManifest } from "../../src/experiments/manifest.js";
import { replayExperiment } from "../../src/experiments/replay.js";
import { PHASE3_CONDITION_IDS } from "../../src/experiments/conditions.js";
import { createLogger } from "../../src/logger.js";
import type { GroundTruthDefect } from "../../src/reporting/benchmark.js";
import type { Finding } from "../../src/types.js";
import { loadTestConfig } from "../helpers/test-config.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "FINDING-001",
    title: "t",
    status: "validated",
    category: "network",
    pageId: "PAGE-001",
    url: "http://localhost:4173/payment",
    pathname: "/payment",
    expected: "e",
    actual: "a",
    oracle: {
      oracleId: "http-failure",
      suspicious: true,
      expected: "e",
      actual: "a",
      details: { newFailures: [{ method: "POST", url: "http://localhost:4173/api/pay-fail", status: 500 }] },
    },
    steps: [],
    reproduction: { attempts: 3, successes: 3 },
    occurrenceCount: 1,
    evidence: ["oracle.json"],
    evidenceLevel: "L3",
    reportDisposition: "needs_human",
    ...overrides,
  };
}

const groundTruth: GroundTruthDefect[] = [{ id: "SEED-003", oracleId: "http-failure", pathname: "/payment" }];

function buildCapturedRun(): { runDir: string; manifest: ReturnType<typeof captureManifest> } {
  const runDir = mkdtempSync(join(tmpdir(), "autoqa-replay-test-"));
  const findings = [finding({ id: "FINDING-001" })];
  for (const f of findings) {
    const dir = join(runDir, "findings", f.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "finding.json"), JSON.stringify(f), "utf-8");
    writeFileSync(join(dir, "oracle.json"), JSON.stringify(f.oracle), "utf-8");
  }
  const manifest = captureManifest({
    experimentId: "EXPERIMENT3-TEST",
    config: loadTestConfig(),
    runId: "RUN-TEST",
    runDir,
    findingIds: findings.map((f) => f.id),
    explorerProviderName: "mock",
  });
  return { runDir, manifest };
}

describe("replayExperiment", () => {
  it("verifies integrity and runs all four conditions purely from persisted evidence", async () => {
    const { manifest } = buildCapturedRun();
    const { integrity, results } = await replayExperiment(manifest, [], createLogger(), groundTruth);

    expect(integrity.valid).toBe(true);
    expect(results.map((r) => r.conditionId).sort()).toEqual([...PHASE3_CONDITION_IDS].sort());
  });

  it("never touches the browser or fixture server", async () => {
    const { manifest } = buildCapturedRun();
    const browserModule = await import("../../src/browser/browser.js");
    const launchSpy = vi.spyOn(browserModule.BrowserManager.prototype, "launch");

    await replayExperiment(manifest, [], createLogger(), groundTruth);

    expect(launchSpy).not.toHaveBeenCalled();
    launchSpy.mockRestore();
  });

  it("replaying the same manifest twice produces identical condition results (deterministic mock provider)", async () => {
    const { manifest } = buildCapturedRun();
    const first = await replayExperiment(manifest, [], createLogger(), groundTruth);
    const second = await replayExperiment(manifest, [], createLogger(), groundTruth);

    expect(second.results).toEqual(first.results);
  });
});
