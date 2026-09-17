import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { parseProfile } from "../../src/profiles/schema.js";
import { profileToAppConfig } from "../../src/profiles/to-app-config.js";
import { generateRunId } from "../../src/report.js";
import { assembleReport, canonicalFindingsOnly } from "../../src/reporting/assemble.js";
import type { PilotSummary } from "../../src/reporting/pilot-report.js";
import { runPipeline } from "../../src/run-pipeline.js";
import { startFixtureServer } from "../../fixture/server.js";

/**
 * Regression lock for the Phase 4 Milestone B extraction: assembleReport()
 * is now the exact function both src/index.ts's CLI and the future UI's
 * RunManager call, replacing what used to be inline logic in
 * index.ts#main(). This test drives the real pipeline against the same
 * qa.config.mock.yaml the project's own `npm run qa`/`npm run benchmark`
 * verification commands use, and asserts the known, previously-manually-
 * verified Phase 3 numbers still come out identically through the
 * extracted path -- not just that it typechecks.
 */
describe("assembleReport() (Phase 4 Milestone B extraction)", () => {
  it("produces the same known result as the pre-extraction CLI path on the mock fixture config", async () => {
    const config = loadConfig(resolve("qa.config.mock.yaml"));
    const startedAt = new Date();
    const runId = generateRunId(startedAt);
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-assemble-test-"));
    const logger = createLogger();

    const pipelineResult = await runPipeline({ config, runId, runDir, logger, headless: true });
    const { summary, report } = assembleReport(pipelineResult, config, runId, runDir, startedAt);

    expect(summary.status).toBe("completed");
    expect(summary.validatedFindings).toBe(9);
    expect(summary.rejectedFindings).toBe(0);
    expect(report.benchmark).toBeDefined();
    expect(report.benchmark?.precision).toBeCloseTo(0.667, 2);
    expect(report.benchmark?.recall).toBeCloseTo(1.0, 2);
    expect(report.phase2).toBeDefined();
    expect(report.phase2?.finalReport.precision).toBeCloseTo(0.75, 2);

    // Every artifact file the CLI previously wrote inline is still written
    // by the extracted function.
    for (const file of ["run-summary.json", "report.json", "report.md", "benchmark.json", "phase2-metrics.json", "grouping.json"]) {
      expect(existsSync(join(runDir, file))).toBe(true);
    }

    const savedReport = JSON.parse(readFileSync(join(runDir, "report.json"), "utf-8")) as typeof report;
    expect(savedReport.runId).toBe(runId);
    expect(savedReport.groups.length).toBeGreaterThan(0); // grouping.enabled:true in qa.config.mock.yaml, and Phase 3's known duplicate-manifestation pair groups.

    // canonicalFindingsOnly() is exported specifically so a UI computes the
    // same deduplicated count the CLI's own grouping.json benchmark used --
    // sanity-check it here directly against the real grouping result.
    const canonical = canonicalFindingsOnly(pipelineResult.finalCtx.findings, {
      groupingVersion: savedReport.groups[0]?.groupingVersion ?? 1,
      enabled: true,
      groups: savedReport.groups,
      ungrouped: savedReport.findings.filter((f) => !f.groupId).map((f) => f.id),
      possibleRelationships: [],
    });
    expect(canonical.length).toBeLessThan(pipelineResult.finalCtx.findings.length);

    // No profile supplied (legacy direct-YAML CLI path) -- pilot-summary.json
    // must never be written here.
    expect(existsSync(join(runDir, "pilot-summary.json"))).toBe(false);
  }, 60_000);

  it("wires buildPilotSummary() into a real run for a non-fixture profile (Phase 4 continuation: previously dead code, unreachable outside its own test)", async () => {
    // §9 fix (2026-09-14 addendum): this test manages its own fixture-
    // server lifecycle directly (unlike the local-fixture-profile test
    // below, which goes through runPipeline()'s auto-start and so must
    // keep a literal port decided up front) -- no chicken-and-egg problem,
    // so it uses an OS-assigned port and reads the real one back.
    const fixtureServer = await startFixtureServer(0);
    try {
      const origin = `http://localhost:${fixtureServer.port}`;
      const profile = parseProfile({
        schemaVersion: 1,
        id: "pilot-wiring-test",
        name: "Pilot Wiring Test",
        target: { url: `${origin}/`, environmentKind: "self-hosted-real-app" },
        navigation: { allowedOrigins: [origin], allowedPathPrefixes: ["/"] },
        resources: { allowedApiOrigins: [origin], allowedFormSubmitEndpoints: [] },
        workflows: { allowedWorkflowKinds: ["navigate"] },
        auth: { mode: "none" },
        provider: {
          explorer: { provider: "mock" },
          critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
          providerTimeoutMs: 30000,
        },
        limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
      });
      const config = profileToAppConfig(profile);
      const startedAt = new Date();
      const runId = generateRunId(startedAt);
      const runDir = mkdtempSync(join(tmpdir(), "autoqa-assemble-pilot-test-"));
      const logger = createLogger();

      const pipelineResult = await runPipeline({ config, runId, runDir, logger, headless: true });
      assembleReport(pipelineResult, config, runId, runDir, startedAt, profile);

      const pilotSummaryPath = join(runDir, "pilot-summary.json");
      expect(existsSync(pilotSummaryPath)).toBe(true);
      const pilotSummary = JSON.parse(readFileSync(pilotSummaryPath, "utf-8")) as PilotSummary;
      expect(pilotSummary.runId).toBe(runId);
      expect(pilotSummary.target.profileId).toBe("pilot-wiring-test");
      // Zero genuine findings is a valid, honest outcome -- this test
      // proves the artifact is WRITTEN, not that findings were found.
      expect(pilotSummary.detection.precision).toBe("N/A");
      expect(pilotSummary.coverageNote.toLowerCase()).toContain("never a claim of business-workflow coverage");
    } finally {
      await fixtureServer.close();
    }
  }, 60_000);

  it("never writes pilot-summary.json for a local-fixture profile", async () => {
    // This one goes through runPipeline()'s local-fixture auto-start
    // (unlike the test above, which starts its own fixture server
    // directly). The literal port below is inert placeholder text
    // (2026-09-16 port isolation fix) -- runPipeline() always binds to an
    // OS-assigned port regardless, so no collision risk exists with any
    // other test file (see tests/helpers/ports.ts).
    const profile = parseProfile({
      schemaVersion: 1,
      id: "fixture-pilot-test",
      name: "Fixture Pilot Test",
      target: { url: "http://localhost:4223/", environmentKind: "local-fixture" },
      navigation: { allowedOrigins: ["http://localhost:4223"], allowedPathPrefixes: ["/"] },
      resources: { allowedApiOrigins: ["http://localhost:4223"], allowedFormSubmitEndpoints: [] },
      workflows: { allowedWorkflowKinds: ["navigate", "search", "filter", "sort", "paginate"] },
      auth: { mode: "none" },
      provider: {
        explorer: { provider: "mock" },
        critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
        providerTimeoutMs: 30000,
      },
      limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
    });
    const config = profileToAppConfig(profile);
    const startedAt = new Date();
    const runId = generateRunId(startedAt);
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-assemble-fixture-pilot-test-"));
    const logger = createLogger();

    const pipelineResult = await runPipeline({ config, runId, runDir, logger, headless: true });
    assembleReport(pipelineResult, config, runId, runDir, startedAt, profile);

    expect(existsSync(join(runDir, "pilot-summary.json"))).toBe(false);
  }, 60_000);
});
