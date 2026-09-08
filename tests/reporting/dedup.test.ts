import { describe, expect, it } from "vitest";
import { buildDedupKey, dedupKeyForFinding, findExistingFinding, normalizedActual } from "../../src/reporting/dedup.js";
import type { Finding } from "../../src/types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "FINDING-001",
    title: "Some finding",
    status: "validated",
    category: "console",
    pageId: "PAGE-001",
    url: "http://localhost:4173/form",
    pathname: "/form",
    expected: "expected",
    actual: "actual",
    oracle: {
      oracleId: "console-error",
      suspicious: true,
      expected: "0 new errors",
      actual: "1 new error",
    },
    controlKey: "button:Submit",
    steps: [],
    reproduction: { attempts: 3, successes: 3 },
    occurrenceCount: 1,
    evidence: [],
    evidenceLevel: "L1",
    reportDisposition: "report",
    ...overrides,
  };
}

describe("normalizedActual", () => {
  it("trims, lowercases, and truncates to 200 characters", () => {
    expect(normalizedActual("  Hello WORLD  ")).toBe("hello world");
    expect(normalizedActual("A".repeat(250))).toBe("a".repeat(200));
  });

  it("does not collapse internal whitespace", () => {
    expect(normalizedActual("a   b")).toBe("a   b");
  });
});

describe("buildDedupKey", () => {
  it("produces the exact pinned oracleId|pathname|controlKey|normalizedActual format", () => {
    expect(buildDedupKey("console-error", "/form", "button:Submit", "1 New Error")).toBe(
      "console-error|/form|button:Submit|1 new error"
    );
  });

  it("uses an empty controlKey when none is associated", () => {
    expect(buildDedupKey("http-failure", "/payment", "", "1 new failure")).toBe(
      "http-failure|/payment||1 new failure"
    );
  });
});

describe("findExistingFinding", () => {
  it("finds a matching finding by its exact dedup key", () => {
    const existing = finding();
    const key = dedupKeyForFinding(existing);

    expect(findExistingFinding([existing], key)).toBe(existing);
  });

  it("does not match a finding with a different oracleId", () => {
    const existing = finding({ oracle: { ...finding().oracle, oracleId: "page-error" } });
    const candidateKey = buildDedupKey("console-error", "/form", "button:Submit", "1 new error");

    expect(findExistingFinding([existing], candidateKey)).toBeUndefined();
  });

  it("does not match a finding with a different pathname", () => {
    const existing = finding({ pathname: "/account" });
    const candidateKey = buildDedupKey("console-error", "/form", "button:Submit", "1 new error");

    expect(findExistingFinding([existing], candidateKey)).toBeUndefined();
  });

  it("matches regardless of case/whitespace differences already normalized into the key", () => {
    const existing = finding({ oracle: { ...finding().oracle, actual: "1 new error" } });
    const candidateKey = buildDedupKey("console-error", "/form", "button:Submit", "  1 NEW ERROR  ");

    expect(findExistingFinding([existing], candidateKey)).toBe(existing);
  });
});
