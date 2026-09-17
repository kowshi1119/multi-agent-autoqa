import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LiveModeNotAuthorizedError } from "../src/models/live-gate.js";
import { readEvidenceBundle, runConditionB, type Phase2ExperimentResult } from "../src/phase2-experiment.js";
import type { Finding, RequirementRule } from "../src/types.js";
import { loadTestConfig, VALID_TEST_YAML } from "./helpers/test-config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "autoqa-phase2-experiment-test-"));
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "FINDING-001",
    title: "t",
    status: "validated",
    category: "network",
    pageId: "PAGE-001",
    url: "http://localhost:4173/expected-failure",
    pathname: "/expected-failure",
    expected: "e",
    actual: "a",
    oracle: { oracleId: "http-failure", suspicious: true, expected: "e", actual: "a" },
    steps: [],
    reproduction: { attempts: 3, successes: 3 },
    occurrenceCount: 1,
    evidence: [],
    evidenceLevel: "L3",
    reportDisposition: "needs_human",
    ...overrides,
  };
}

describe("readEvidenceBundle", () => {
  it("reconstructs an evidence bundle from a finding's persisted evidence files", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "console.json"), JSON.stringify([{ type: "error", text: "x", timestamp: "t" }]));
    writeFileSync(join(dir, "network.json"), JSON.stringify([{ method: "POST", url: "http://x/api/y", status: 500, timestamp: "t" }]));
    writeFileSync(join(dir, "page-errors.json"), JSON.stringify([{ message: "boom", timestamp: "t" }]));
    writeFileSync(join(dir, "visible-text.json"), JSON.stringify({ excerpt: "Service temporarily unavailable" }));
    writeFileSync(join(dir, "screenshot.png"), "");

    const bundle = readEvidenceBundle(dir);

    expect(bundle.consoleMessages).toHaveLength(1);
    expect(bundle.networkRequests).toHaveLength(1);
    expect(bundle.pageErrors).toHaveLength(1);
    expect(bundle.visibleTextExcerpt).toBe("Service temporarily unavailable");
    expect(bundle.screenshotPath).toBe(join(dir, "screenshot.png"));
    expect(bundle.tracePath).toBeUndefined();
  });

  it("degrades gracefully to empty defaults when evidence files are missing", () => {
    const dir = tempDir();
    const bundle = readEvidenceBundle(dir);

    expect(bundle).toEqual({ consoleMessages: [], networkRequests: [], pageErrors: [], visibleTextExcerpt: "" });
  });
});

describe("runConditionB", () => {
  it("suppresses a finding whose evidence matches a scoped requirement, purely from persisted evidence", async () => {
    const runDir = tempDir();
    const findingDir = join(runDir, "findings", "FINDING-001");
    mkdirSync(findingDir, { recursive: true });
    writeFileSync(join(findingDir, "network.json"), JSON.stringify([
      { method: "POST", url: "http://localhost:4173/api/simulated-outage", status: 500, timestamp: "t" },
    ]));
    writeFileSync(join(findingDir, "visible-text.json"), JSON.stringify({ excerpt: "Service temporarily unavailable." }));

    const requirements: RequirementRule[] = [
      {
        id: "REQ-001",
        pathname: "/expected-failure",
        description: "Documented failure handling.",
        triggerRequestPathname: "/api/simulated-outage",
        expectedVisibleText: "Service temporarily unavailable",
      },
    ];

    const outDir = tempDir();
    const result = await runConditionB([finding()], runDir, loadTestConfig(), requirements, outDir);

    expect(result.findings[0]?.reportDisposition).toBe("suppress");
    expect(result.findings[0]?.critic?.verdict).toBe("invalid");
    expect(result.benchmark.reportedValidatedFindings).toBe(0);
  });

  it("leaves a non-validated finding's disposition to decideDisposition's skipped/rejected path, untouched by the critic", async () => {
    const runDir = tempDir();
    const outDir = tempDir();
    const rejected = finding({ status: "rejected", reportDisposition: "suppress" });

    const result = await runConditionB([rejected], runDir, loadTestConfig(), [], outDir);

    expect(result.findings).toEqual([rejected]);
  });

  it("reports a genuine finding as reportable when no requirement matches", async () => {
    const runDir = tempDir();
    const findingDir = join(runDir, "findings", "FINDING-001");
    mkdirSync(findingDir, { recursive: true });
    writeFileSync(join(findingDir, "network.json"), JSON.stringify([
      { method: "POST", url: "http://localhost:4173/api/payment-consistency", status: 500, timestamp: "t" },
    ]));

    const outDir = tempDir();
    const result = await runConditionB(
      [finding({ pathname: "/payment", oracle: { oracleId: "ui-api-consistency", suspicious: true, expected: "e", actual: "a" }, evidenceLevel: "L1" })],
      runDir,
      loadTestConfig(),
      [],
      outDir
    );

    expect(result.findings[0]?.reportDisposition).toBe("report");
  });
});

describe("live-execution gating (2026-09-11 review fix: this entry point previously bypassed --live entirely)", () => {
  it("refuses to start -- never calling runPipeline() -- when the configured explorer is live and --live was not passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autoqa-phase2-live-gate-test-"));
    const configPath = join(dir, "qa.config.yaml");
    writeFileSync(
      configPath,
      VALID_TEST_YAML.replace('provider: "mock"', 'provider: "anthropic"\n    model: "claude-fake-model"'),
      "utf-8"
    );

    const runPipelineModule = await import("../src/run-pipeline.js");
    const runPipelineSpy = vi.spyOn(runPipelineModule, "runPipeline");

    const originalArgv = process.argv;
    process.argv = [...originalArgv.slice(0, 2), "--config", configPath];
    try {
      const { main } = await import("../src/phase2-experiment.js");
      await expect(main()).rejects.toBeInstanceOf(LiveModeNotAuthorizedError);
      expect(runPipelineSpy).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      runPipelineSpy.mockRestore();
    }
  });
});

describe("Phase2ExperimentResult shape", () => {
  it("types conditionC as a literal null -- never a fabricated result", () => {
    const result: Phase2ExperimentResult = {
      conditionA: { runId: "RUN-x", runDir: "runs/RUN-x", benchmark: { matchedOn: "oracleId+pathname", seededDefects: 0, reportedValidatedFindings: 0, truePositives: [], falsePositives: [], falseNegatives: [], precision: 0, recall: 0, f1: 0 } },
      conditionB: { runDir: "runs/experiments/x/condition-b", benchmark: { matchedOn: "oracleId+pathname", seededDefects: 0, reportedValidatedFindings: 0, truePositives: [], falsePositives: [], falseNegatives: [], precision: 0, recall: 0, f1: 0 } },
      conditionC: null,
      conditionCNote: "SKIPPED",
      metrics: { detection: { matchedOn: "oracleId+pathname", seededDefects: 0, reportedValidatedFindings: 0, truePositives: [], falsePositives: [], falseNegatives: [], precision: 0, recall: 0, f1: 0 }, finalReport: { matchedOn: "oracleId+pathname", seededDefects: 0, reportedValidatedFindings: 0, truePositives: [], falsePositives: [], falseNegatives: [], precision: 0, recall: 0, f1: 0 }, falsePositivesSuppressed: 0, falsePositiveReductionRate: 0, recallLoss: 0 },
    };
    expect(result.conditionC).toBeNull();
  });
});
