import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTriage, saveTriageLabel, TriageError } from "../../src/human-review/triage.js";

describe("triage (Phase 4 Milestone D2 -- ordinary, non-blind manual labels)", () => {
  it("loadTriage returns an empty file when none exists yet", () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-triage-test-"));
    expect(loadTriage(runDir)).toEqual({ schemaVersion: 1, labels: [] });
  });

  it("saves a label and persists it separately from any finding.json/report.json", () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-triage-test-"));
    writeFileSync(join(runDir, "report.json"), JSON.stringify({ findings: [{ id: "FINDING-001", reportDisposition: "report" }] }), "utf-8");

    saveTriageLabel(runDir, "FINDING-001", "defect", "confirmed via manual repro");

    expect(existsSync(join(runDir, "triage.json"))).toBe(true);
    const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf-8")) as { findings: Array<{ id: string; reportDisposition: string }> };
    expect(report.findings[0]?.reportDisposition).toBe("report"); // untouched

    const triage = loadTriage(runDir);
    expect(triage.labels).toHaveLength(1);
    expect(triage.labels[0]).toMatchObject({ findingId: "FINDING-001", verdict: "defect", notes: "confirmed via manual repro" });
  });

  it("re-triaging the same finding replaces its prior label rather than accumulating history", () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-triage-test-"));
    saveTriageLabel(runDir, "FINDING-001", "unsure");
    saveTriageLabel(runDir, "FINDING-001", "expected-behavior", "actually documented behavior");

    const triage = loadTriage(runDir);
    expect(triage.labels).toHaveLength(1);
    expect(triage.labels[0]?.verdict).toBe("expected-behavior");
  });

  it("labels for different findings coexist independently", () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-triage-test-"));
    saveTriageLabel(runDir, "FINDING-001", "defect");
    saveTriageLabel(runDir, "FINDING-002", "unsure");

    const triage = loadTriage(runDir);
    expect(triage.labels).toHaveLength(2);
    expect(triage.labels.map((l) => l.findingId).sort()).toEqual(["FINDING-001", "FINDING-002"]);
  });

  it("rejects an invalid verdict", () => {
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-triage-test-"));
    expect(() => saveTriageLabel(runDir, "FINDING-001", "bogus-verdict" as never)).toThrow(TriageError);
  });
});
