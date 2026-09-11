import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// src/experiments and src/human-review are deliberately NOT forbidden:
// both legitimately take ground truth as an explicit function parameter
// for evaluation purposes (computing a per-condition benchmark, scoring
// human-rater agreement), exactly like src/reporting/benchmark.ts and
// src/index.ts already do -- ground truth flowing through evaluation code
// is fine; the invariant this test protects is that it never reaches
// anything Planner/Explorer/Oracles/Validator/Critic/grouping-adjacent.
const FORBIDDEN_DIRS = ["src/qa", "src/models", "src/critic", "src/oracles", "src/grouping"];
const FORBIDDEN_FILES = [
  "src/explorer.ts",
  "src/requirements.ts",
  "src/validator.ts",
  "src/orchestrator/orchestrator.ts",
  // Phase 4 Milestone C: a real-application pilot summary must never
  // score against the fixture's ground truth -- "never load the fixture
  // ground truth to score OrangeHRM."
  "src/reporting/pilot-report.ts",
];

function allTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return allTsFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("ground truth never reaches the Explorer/model/grouping path", () => {
  it("contains no reference to ground-truth in any forbidden directory or file", () => {
    const files = [...FORBIDDEN_DIRS.flatMap(allTsFiles), ...FORBIDDEN_FILES];
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      expect(content.toLowerCase()).not.toContain("ground-truth");
      expect(content.toLowerCase()).not.toContain("ground_truth");
      expect(content).not.toContain("groundTruth");
    }
  });
});
