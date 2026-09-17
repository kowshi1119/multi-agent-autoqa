import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { generateRunId } from "../src/report.js";
import { runPipeline } from "../src/run-pipeline.js";
import { loadTestConfig } from "./helpers/test-config.js";

/**
 * §Port isolation fix (2026-09-16): previously, a local-fixture run's own
 * fixture server was bound to whatever literal port `config.target.url`
 * declared -- six test files hand-picked distinct literal ports purely to
 * avoid EADDRINUSE collisions with each other (see tests/helpers/ports.ts).
 * `runPipeline()` now always binds to an OS-assigned port (0) and
 * substitutes the real origin back into `config` before anything reads it,
 * regardless of what port the config declares. This test proves the actual
 * isolation property directly -- not merely the absence of a failure -- by
 * running two local-fixture pipelines concurrently that both declare the
 * exact SAME placeholder port, and asserting both succeed on two distinct
 * real ports.
 */
describe("runPipeline() local-fixture port isolation", () => {
  it("two concurrent local-fixture runs declaring the same placeholder port both succeed on distinct real ports", async () => {
    const configA = loadTestConfig();
    const configB = loadTestConfig();
    expect(configA.target.url).toBe(configB.target.url); // both declare the same placeholder port before the fix applies

    const logger = createLogger();
    const startedAt = new Date();
    const runIdA = generateRunId(startedAt);
    const runIdB = generateRunId(startedAt);
    const runDirA = mkdtempSync(join(tmpdir(), "autoqa-port-isolation-a-"));
    const runDirB = mkdtempSync(join(tmpdir(), "autoqa-port-isolation-b-"));

    const [resultA, resultB] = await Promise.all([
      runPipeline({ config: configA, runId: runIdA, runDir: runDirA, logger, headless: true }),
      runPipeline({ config: configB, runId: runIdB, runDir: runDirB, logger, headless: true }),
    ]);

    // Neither run failed (both reached a terminal, non-FAILED state) --
    // if the two fixture servers had collided on the same literal port,
    // the second to bind would have thrown EADDRINUSE and runPipeline()
    // itself would have rejected before this line.
    expect(resultA.finalCtx.state).not.toBe("FAILED");
    expect(resultB.finalCtx.state).not.toBe("FAILED");

    // Each pipeline mutated its OWN config in place to the real bound
    // origin -- and the two are different, proving genuine OS-assigned
    // isolation, not a shared/reused port.
    expect(configA.target.url).not.toBe(configB.target.url);
    expect(new URL(configA.target.url).port).not.toBe(new URL(configB.target.url).port);
  }, 60_000);
});
