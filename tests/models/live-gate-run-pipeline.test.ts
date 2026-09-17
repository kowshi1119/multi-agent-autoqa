import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import { LiveModeNotAuthorizedError } from "../../src/models/live-gate.js";
import { runPipeline } from "../../src/run-pipeline.js";
import { loadTestConfig } from "../helpers/test-config.js";

describe("runPipeline() live-execution gating (Phase 4 continuation)", () => {
  it("refuses to start -- before ever selecting a provider or launching a browser -- when the explorer is configured live and --live was not passed", async () => {
    // No ANTHROPIC_API_KEY is set in this test environment, so if the
    // gate did NOT fire before selectProvider(), this would instead fail
    // later with a ConfigError about a missing API key -- asserting
    // LiveModeNotAuthorizedError specifically proves the gate runs first.
    const config = loadTestConfig((y) => y.replace('provider: "mock"', 'provider: "anthropic"\n    model: "claude-fake-model"'));
    const runId = "RUN-LIVE-GATE-TEST";
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-live-gate-test-"));
    const logger = createLogger();

    await expect(
      runPipeline({
        config,
        runId,
        runDir,
        logger,
        headless: true,
        requireLiveAuthorization: { argv: [] },
      })
    ).rejects.toBeInstanceOf(LiveModeNotAuthorizedError);
  });

  it("proceeds (does not throw LiveModeNotAuthorizedError) for an all-mock configuration with no --live flag", async () => {
    // The literal port here is inert placeholder text (2026-09-16 port
    // isolation fix) -- runPipeline() always binds this local-fixture
    // target to an OS-assigned port regardless, so no collision risk exists
    // with any other test file's own config (see tests/helpers/ports.ts).
    const config = loadTestConfig();
    const runId = "RUN-LIVE-GATE-MOCK-TEST";
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-live-gate-mock-test-"));
    const logger = createLogger();

    const result = await runPipeline({
      config,
      runId,
      runDir,
      logger,
      headless: true,
      requireLiveAuthorization: { argv: [] },
    });

    expect(result.usageTracker.summary().explorer.requests).toBe(0);
  }, 30_000);

  it("a caller that never supplies requireLiveAuthorization (e.g. RunManager's own separately-gated path) is entirely unaffected", async () => {
    const config = loadTestConfig((y) => y.replace('provider: "mock"', 'provider: "anthropic"\n    model: "claude-fake-model"'));
    const runId = "RUN-LIVE-GATE-NO-OPT-IN-TEST";
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-live-gate-no-opt-in-test-"));
    const logger = createLogger();

    // Absent requireLiveAuthorization entirely, runPipeline() never calls
    // assertLiveModeAuthorized -- it instead fails downstream exactly as
    // it always did (a ConfigError from selectProvider, since no
    // ANTHROPIC_API_KEY is set in this test environment), never a
    // LiveModeNotAuthorizedError.
    await expect(
      runPipeline({
        config,
        runId,
        runDir,
        logger,
        headless: true,
      })
    ).rejects.not.toBeInstanceOf(LiveModeNotAuthorizedError);
  });
});
