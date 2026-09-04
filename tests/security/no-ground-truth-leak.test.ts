import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN_DIRS = ["src/qa", "src/models"];
const FORBIDDEN_FILES = ["src/explorer.ts"];

function allTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return allTsFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("ground truth never reaches the Explorer/model path", () => {
  it("contains no reference to ground-truth in src/qa/, src/models/, or src/explorer.ts", () => {
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
