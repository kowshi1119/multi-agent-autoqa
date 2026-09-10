import { describe, expect, it } from "vitest";
import { oracleFailureSignature, sameFailure } from "../../src/oracles/signature.js";
import type { OracleResult } from "../../src/types.js";

function httpFailure(url: string, status: number): OracleResult {
  return {
    oracleId: "http-failure",
    suspicious: true,
    expected: "0 new HTTP 5xx responses",
    actual: "1 new HTTP 5xx response",
    details: { newFailures: [{ method: "POST", url, status }] },
  };
}

function uiApiConsistency(ruleId: string, url: string, status: number): OracleResult {
  return {
    oracleId: "ui-api-consistency",
    suspicious: true,
    expected: "e",
    actual: "a",
    details: { ruleId, newFailures: [{ method: "POST", url, status }] },
  };
}

function duplicateRequest(method: string, pathname: string, newCount: number): OracleResult {
  return {
    oracleId: "duplicate-request",
    suspicious: true,
    expected: "e",
    actual: "a",
    details: { violations: [{ method, pathname, expectedMax: 1, newCount }] },
  };
}

function consoleError(messages: string[]): OracleResult {
  return {
    oracleId: "console-error",
    suspicious: true,
    expected: "0 new unexpected error-level console messages",
    actual: `${messages.length} new unexpected error-level console message(s)`,
    details: { newErrors: messages },
  };
}

describe("oracleFailureSignature / sameFailure", () => {
  it("http-failure: same endpoint+status twice -> same signature", () => {
    const a = httpFailure("http://localhost:4173/api/pay-fail", 500);
    const b = httpFailure("http://localhost:4173/api/pay-fail", 500);
    expect(sameFailure(a, b)).toBe(true);
  });

  it("http-failure: different endpoint -> different signature", () => {
    const a = httpFailure("http://localhost:4173/api/pay-fail", 500);
    const b = httpFailure("http://localhost:4173/api/payment-consistency", 500);
    expect(sameFailure(a, b)).toBe(false);
  });

  it("http-failure: different status -> different signature", () => {
    const a = httpFailure("http://localhost:4173/api/pay-fail", 500);
    const b = httpFailure("http://localhost:4173/api/pay-fail", 503);
    expect(sameFailure(a, b)).toBe(false);
  });

  it("ui-api-consistency: different ruleId, same endpoint -> different signature (rule identity matters)", () => {
    const a = uiApiConsistency("rule-a", "http://localhost:4173/api/x", 500);
    const b = uiApiConsistency("rule-b", "http://localhost:4173/api/x", 500);
    expect(sameFailure(a, b)).toBe(false);
  });

  it("duplicate-request: differing only in newCount -> same signature (volatile field excluded)", () => {
    const a = duplicateRequest("POST", "/api/submit", 2);
    const b = duplicateRequest("POST", "/api/submit", 5);
    expect(sameFailure(a, b)).toBe(true);
  });

  it("duplicate-request: different endpoint -> different signature", () => {
    const a = duplicateRequest("POST", "/api/submit", 2);
    const b = duplicateRequest("POST", "/api/other", 2);
    expect(sameFailure(a, b)).toBe(false);
  });

  it("console-error: same set of normalized messages -> same signature, case/whitespace-insensitive", () => {
    const a = consoleError(["Seeded QA defect"]);
    const b = consoleError(["  seeded qa defect  "]);
    expect(sameFailure(a, b)).toBe(true);
  });

  it("console-error: different message set -> different signature", () => {
    const a = consoleError(["Seeded QA defect"]);
    const b = consoleError(["A completely different error"]);
    expect(sameFailure(a, b)).toBe(false);
  });

  it("different oracleId -> never the same failure, even with coincidentally identical actual text", () => {
    const a: OracleResult = { oracleId: "console-error", suspicious: true, expected: "e", actual: "same text", details: { newErrors: ["x"] } };
    const b: OracleResult = { oracleId: "page-error", suspicious: true, expected: "e", actual: "same text", details: { newErrors: ["x"] } };
    expect(sameFailure(a, b)).toBe(false);
  });

  it("unregistered oracle id falls back to oracleId + normalizedActual equality", () => {
    const a: OracleResult = { oracleId: "future-oracle", suspicious: true, expected: "e", actual: "Something Failed" };
    const b: OracleResult = { oracleId: "future-oracle", suspicious: true, expected: "e", actual: "something failed" };
    const c: OracleResult = { oracleId: "future-oracle", suspicious: true, expected: "e", actual: "a different failure" };
    expect(sameFailure(a, b)).toBe(true);
    expect(sameFailure(a, c)).toBe(false);
  });

  it("oracleFailureSignature is order-independent for multiple simultaneous failures", () => {
    const a: OracleResult = {
      oracleId: "http-failure",
      suspicious: true,
      expected: "e",
      actual: "a",
      details: {
        newFailures: [
          { method: "POST", url: "http://localhost:4173/api/a", status: 500 },
          { method: "POST", url: "http://localhost:4173/api/b", status: 500 },
        ],
      },
    };
    const b: OracleResult = {
      oracleId: "http-failure",
      suspicious: true,
      expected: "e",
      actual: "a",
      details: {
        newFailures: [
          { method: "POST", url: "http://localhost:4173/api/b", status: 500 },
          { method: "POST", url: "http://localhost:4173/api/a", status: 500 },
        ],
      },
    };
    expect(oracleFailureSignature(a)).toBe(oracleFailureSignature(b));
  });
});
