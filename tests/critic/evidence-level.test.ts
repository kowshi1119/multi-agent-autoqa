import { afterEach, describe, expect, it, vi } from "vitest";
import { UNCLASSIFIED_ORACLE_EVIDENCE_LEVEL, evidenceLevelForOracle } from "../../src/critic/evidence-level.js";
import type { Logger } from "../../src/logger.js";

const REGISTERED: Array<[string, string]> = [
  ["duplicate-request", "L1"],
  ["ui-api-consistency", "L1"],
  ["requirement-rule", "L2"],
  ["page-error", "L3"],
  ["http-failure", "L3"],
  ["console-error", "L3"],
];

describe("evidenceLevelForOracle", () => {
  it.each(REGISTERED)("returns the registered level for %s", (oracleId, expected) => {
    expect(evidenceLevelForOracle(oracleId)).toBe(expected);
  });

  it("defaults an unregistered oracle id to the conservative UNCLASSIFIED level, never L3", () => {
    expect(evidenceLevelForOracle("some-future-oracle")).toBe(UNCLASSIFIED_ORACLE_EVIDENCE_LEVEL);
    expect(UNCLASSIFIED_ORACLE_EVIDENCE_LEVEL).toBe("L6");
  });

  it("logs a diagnostic via the provided Logger for an unregistered oracle id", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    evidenceLevelForOracle("some-future-oracle", logger);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({ oracleId: "some-future-oracle" });
    expect(warn.mock.calls[0]?.[1]).toContain("EVIDENCE_LEVEL_UNCLASSIFIED");
  });

  it("falls back to console.warn when no logger is provided, and still returns the conservative default", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const level = evidenceLevelForOracle("some-future-oracle");
    expect(level).toBe("L6");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
