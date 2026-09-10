import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCondition } from "../../src/experiments/conditions.js";
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

function tempRunDir(findingIds: string[]): string {
  const runDir = mkdtempSync(join(tmpdir(), "autoqa-conditions-test-"));
  for (const id of findingIds) {
    mkdirSync(join(runDir, "findings", id), { recursive: true });
    writeFileSync(join(runDir, "findings", id, "oracle.json"), "{}", "utf-8");
  }
  return runDir;
}

const groundTruth: GroundTruthDefect[] = [{ id: "SEED-003", oracleId: "http-failure", pathname: "/payment" }];

describe("runCondition", () => {
  it("critic_off_grouping_off: no critic field on any finding, nothing grouped", async () => {
    const a = finding({ id: "FINDING-001", controlKey: "x" });
    const b = finding({ id: "FINDING-002", controlKey: "y" });
    const runDir = tempRunDir(["FINDING-001", "FINDING-002"]);

    const result = await runCondition("critic_off_grouping_off", [a, b], runDir, loadTestConfig(), [], createLogger(), groundTruth);

    expect(result.findings.every((f) => !f.critic)).toBe(true);
    expect(result.grouping.groups).toHaveLength(0);
    expect(result.findings.every((f) => f.reportDisposition === "report")).toBe(true);
    expect(result.benchmark.truePositives).toHaveLength(1); // both map to the same ground-truth entry; first wins, second is a benchmark FP
  });

  it("critic_off_grouping_on: duplicate manifestations consolidate into one reportable canonical finding", async () => {
    const a = finding({ id: "FINDING-001", controlKey: "x" });
    const b = finding({ id: "FINDING-002", controlKey: "y" });
    const runDir = tempRunDir(["FINDING-001", "FINDING-002"]);

    const result = await runCondition("critic_off_grouping_on", [a, b], runDir, loadTestConfig(), [], createLogger(), groundTruth);

    expect(result.grouping.groups).toHaveLength(1);
    expect(result.benchmark.precision).toBe(1); // canonical-only reportable set matches 1:1 against ground truth
  });

  it("critic_on_grouping_off: MockCriticProvider actually reviews each finding (real selectCriticProvider path, not hardcoded)", async () => {
    const a = finding({ id: "FINDING-001", controlKey: "x" });
    const runDir = tempRunDir(["FINDING-001"]);

    const result = await runCondition("critic_on_grouping_off", [a], runDir, loadTestConfig(), [], createLogger(), groundTruth);

    expect(result.findings[0]?.critic).toBeDefined();
    expect(result.findings[0]?.critic?.provider).toBe("mock");
    expect(result.findings[0]?.reportDisposition).toBe("report");
  });

  it("critic_on_grouping_on: both critic review and grouping apply together", async () => {
    const a = finding({ id: "FINDING-001", controlKey: "x" });
    const b = finding({ id: "FINDING-002", controlKey: "y" });
    const runDir = tempRunDir(["FINDING-001", "FINDING-002"]);

    const result = await runCondition("critic_on_grouping_on", [a, b], runDir, loadTestConfig(), [], createLogger(), groundTruth);

    expect(result.findings.every((f) => f.critic !== undefined)).toBe(true);
    expect(result.grouping.groups).toHaveLength(1);
    expect(result.benchmark.precision).toBe(1);
  });

  it("a non-validated finding is never sent to the critic regardless of condition", async () => {
    const rejected = finding({ id: "FINDING-001", status: "rejected", reportDisposition: "suppress" });
    const runDir = tempRunDir(["FINDING-001"]);

    const result = await runCondition("critic_on_grouping_off", [rejected], runDir, loadTestConfig(), [], createLogger(), groundTruth);

    expect(result.findings[0]?.critic).toBeUndefined();
    expect(result.findings[0]?.reportDisposition).toBe("suppress");
  });
});
