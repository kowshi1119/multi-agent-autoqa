import { describe, expect, it } from "vitest";
import { selectConsoleEvidence, selectNetworkEvidence } from "../../src/critic/evidence-scope.js";
import type { ConsoleRecord, NetworkRecord, OracleResult } from "../../src/types.js";

function consoleRecord(text: string): ConsoleRecord {
  return { type: "error", text, timestamp: "t" };
}

function networkRecord(method: string, url: string, status: number): NetworkRecord {
  return { method, url, status, timestamp: "t" };
}

describe("selectConsoleEvidence", () => {
  const triggering: OracleResult = {
    oracleId: "console-error",
    suspicious: true,
    expected: "e",
    actual: "a",
    details: { newErrors: ["the triggering error"] },
  };

  it("always force-includes the triggering oracle's own referenced messages, even under a tight limit", () => {
    const all = [
      consoleRecord("noise 1"),
      consoleRecord("noise 2"),
      consoleRecord("the triggering error"),
      consoleRecord("noise 3"),
    ];
    const result = selectConsoleEvidence(all, triggering, 1);
    expect(result.selected.map((m) => m.text)).toContain("the triggering error");
  });

  it("discloses totalCaptured/omitted so a truncated list is never mistaken for an empty one", () => {
    const all = Array.from({ length: 30 }, (_, i) => consoleRecord(`msg ${i}`));
    const result = selectConsoleEvidence(all, { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" }, 20);
    expect(result.totalCaptured).toBe(30);
    expect(result.selected).toHaveLength(20);
    expect(result.omitted).toBe(10);
  });

  it("an oracle with zero captured messages reports totalCaptured:0, not merely an empty selected array", () => {
    const result = selectConsoleEvidence([], { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" }, 20);
    expect(result.totalCaptured).toBe(0);
    expect(result.omitted).toBe(0);
    expect(result.selected).toEqual([]);
  });
});

describe("selectNetworkEvidence", () => {
  const triggering: OracleResult = {
    oracleId: "http-failure",
    suspicious: true,
    expected: "e",
    actual: "a",
    details: { newFailures: [{ method: "POST", url: "http://localhost:4173/api/pay-fail", status: 500 }] },
  };

  it("force-includes the triggering request even under a tight limit", () => {
    const all = [
      networkRecord("GET", "http://localhost:4173/other-1", 200),
      networkRecord("GET", "http://localhost:4173/other-2", 200),
      networkRecord("POST", "http://localhost:4173/api/pay-fail", 500),
    ];
    const result = selectNetworkEvidence(all, triggering, 1);
    expect(result.selected.some((r) => r.url.includes("pay-fail"))).toBe(true);
  });

  it("never compares an endpoint-specific count against total page traffic without disclosing both", () => {
    const all = [
      networkRecord("GET", "http://localhost:4173/unrelated-1", 200),
      networkRecord("GET", "http://localhost:4173/unrelated-2", 200),
      networkRecord("GET", "http://localhost:4173/unrelated-3", 200),
      networkRecord("POST", "http://localhost:4173/api/pay-fail", 500),
    ];
    const result = selectNetworkEvidence(all, triggering, 20);
    expect(result.totalPageRequests).toBe(4);
    expect(result.matchedForTriggeringEndpoint).toBe(1);
  });

  it("matchedForTriggeringEndpoint counts every request to that endpoint, not just the ones the oracle flagged as new", () => {
    const all = [
      networkRecord("POST", "http://localhost:4173/api/pay-fail", 200),
      networkRecord("POST", "http://localhost:4173/api/pay-fail", 500),
    ];
    const result = selectNetworkEvidence(all, triggering, 20);
    expect(result.matchedForTriggeringEndpoint).toBe(2);
  });

  it("reports zero matched-endpoint count when the triggering oracle has no network details (e.g. console-error)", () => {
    const consoleTriggering: OracleResult = { oracleId: "console-error", suspicious: true, expected: "e", actual: "a", details: { newErrors: ["x"] } };
    const all = [networkRecord("GET", "http://localhost:4173/x", 200)];
    const result = selectNetworkEvidence(all, consoleTriggering, 20);
    expect(result.matchedForTriggeringEndpoint).toBe(0);
    expect(result.totalPageRequests).toBe(1);
  });
});
