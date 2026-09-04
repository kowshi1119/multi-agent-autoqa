import { describe, expect, it } from "vitest";
import { createHttpFailureOracle } from "../../src/oracles/http-failure.js";
import type { NetworkRecord, Observation, RecordedStep } from "../../src/types.js";

function observation(networkRequests: NetworkRecord[]): Observation {
  return {
    timestamp: new Date().toISOString(),
    page: { url: "http://localhost:4173/payment", title: "Payment", pathname: "/payment" },
    viewport: { width: 1440, height: 900 },
    visibleText: "",
    interactiveElements: [],
    forms: [],
    links: [],
    consoleMessages: [],
    pageErrors: [],
    networkRequests,
    dialogs: [],
    stateSignature: "irrelevant",
  };
}

function req(method: string, url: string, status: number): NetworkRecord {
  return { method, url, status, resourceType: "fetch", timestamp: new Date().toISOString() };
}

const step: RecordedStep = {
  number: 1,
  action: { type: "click", target: { role: "button", name: "Simulate Payment Error" } },
  timestamp: new Date().toISOString(),
};

describe("http-failure oracle", () => {
  it("flags a newly occurring HTTP 500 as suspicious", async () => {
    const oracle = createHttpFailureOracle();
    const before = observation([]);
    const after = observation([req("POST", "http://localhost:4173/api/pay-fail", 500)]);

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(true);
    expect(result.oracleId).toBe("http-failure");
  });

  it("does not flag a pre-existing HTTP 500 that persists unchanged", async () => {
    const oracle = createHttpFailureOracle();
    const record = req("POST", "http://localhost:4173/api/pay-fail", 500);
    const before = observation([record]);
    const after = observation([record]);

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(false);
  });

  it("never flags a 4xx response, no matter how many occur", async () => {
    const oracle = createHttpFailureOracle();
    const before = observation([]);
    const after = observation([
      req("GET", "http://localhost:4173/missing", 404),
      req("POST", "http://localhost:4173/api/submit", 400),
      req("GET", "http://localhost:4173/forbidden", 403),
    ]);

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(false);
  });
});
