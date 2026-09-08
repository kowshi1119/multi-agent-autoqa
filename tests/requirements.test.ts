import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RequirementContextError, loadRequirements, scopeRequirements } from "../src/requirements.js";
import type { RequirementRule } from "../src/types.js";

function writeRequirementsFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "autoqa-requirements-test-"));
  const path = join(dir, "requirements.json");
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("loadRequirements", () => {
  it("loads a valid requirements file's rules array", () => {
    const path = writeRequirementsFile(
      JSON.stringify({ rules: [{ id: "REQ-001", pathname: "/expected-failure", description: "d" }] })
    );
    expect(loadRequirements(path)).toEqual([{ id: "REQ-001", pathname: "/expected-failure", description: "d" }]);
  });

  it("returns an empty array when the file does not exist (requirements are optional)", () => {
    expect(loadRequirements("/nonexistent/requirements.json")).toEqual([]);
  });

  it("throws REQUIREMENT_CONTEXT_ERROR on invalid JSON", () => {
    const path = writeRequirementsFile("{ not valid json");
    expect(() => loadRequirements(path)).toThrow(RequirementContextError);
    expect(() => loadRequirements(path)).toThrow(/REQUIREMENT_CONTEXT_ERROR/);
  });

  it("throws REQUIREMENT_CONTEXT_ERROR when the top-level rules array is missing", () => {
    const path = writeRequirementsFile(JSON.stringify({ notRules: [] }));
    expect(() => loadRequirements(path)).toThrow(/REQUIREMENT_CONTEXT_ERROR/);
  });
});

describe("scopeRequirements", () => {
  const rules: RequirementRule[] = [
    { id: "REQ-001", pathname: "/expected-failure", description: "a" },
    { id: "REQ-002", pathname: "/payment", description: "b" },
  ];

  it("returns only rules matching the given pathname", () => {
    expect(scopeRequirements(rules, "/expected-failure")).toEqual([rules[0]]);
  });

  it("returns an empty array when no rule matches", () => {
    expect(scopeRequirements(rules, "/nowhere")).toEqual([]);
  });
});
