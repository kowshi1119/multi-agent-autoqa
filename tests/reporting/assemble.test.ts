import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { generateRunId } from "../../src/report.js";
import { assembleReport, canonicalFindingsOnly } from "../../src/reporting/assemble.js";
import { runPipeline } from "../../src/run-pipeline.js";

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
  }, 60_000);
});
