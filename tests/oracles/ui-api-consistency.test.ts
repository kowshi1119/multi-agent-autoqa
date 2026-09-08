import { describe, expect, it } from "vitest";
import { createUiApiConsistencyOracle } from "../../src/oracles/ui-api-consistency.js";
import type { NetworkRecord, Observation, RecordedStep } from "../../src/types.js";
import { loadTestConfig } from "../helpers/test-config.js";

const RULE_YAML = [
  "uiApiConsistency:",
  "    enabled: true",
  "    rules:",
  '      - id: "payment-consistency"',
  "        request:",
  '          method: "POST"',
  '          pathname: "/api/payment-consistency"',
  "        failureStatusMin: 500",
  '        forbiddenVisibleText: "Payment successful"',
].join("\n");

function configWithRule() {
  return loadTestConfig((y) => y.replace("uiApiConsistency:\n    enabled: true\n    rules: []", RULE_YAML));
}

function observation(networkRequests: NetworkRecord[], visibleText = ""): Observation {
  return {
    timestamp: new Date().toISOString(),
    page: { url: "http://localhost:4173/payment", title: "Payment", pathname: "/payment" },
    viewport: { width: 1440, height: 900 },
    visibleText,
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
  action: { type: "click", target: { role: "button", name: "Submit Payment" } },
  timestamp: new Date().toISOString(),
};

describe("ui-api-consistency oracle", () => {
  it("flags a new matching-rule failure when the UI still shows the forbidden success text", async () => {
    const oracle = createUiApiConsistencyOracle(configWithRule());
    const before = observation([]);
    const after = observation(
      [req("POST", "http://localhost:4173/api/payment-consistency", 500)],
      "Payment successful"
    );

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(true);
    expect(result.oracleId).toBe("ui-api-consistency");
  });

  it("does not flag the same failure when the UI correctly shows a failure message instead", async () => {
    const oracle = createUiApiConsistencyOracle(configWithRule());
    const before = observation([]);
    const after = observation(
      [req("POST", "http://localhost:4173/api/payment-consistency", 500)],
      "Service temporarily unavailable. Please try again later."
    );

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(false);
  });

  it("does not flag when no configured rule matches the request", async () => {
    const oracle = createUiApiConsistencyOracle(configWithRule());
    const before = observation([]);
    const after = observation(
      [req("POST", "http://localhost:4173/api/pay-fail", 500)],
      "Payment successful"
    );

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(false);
  });

  it("is inert with no rules configured", async () => {
    const oracle = createUiApiConsistencyOracle(loadTestConfig());
    const before = observation([]);
    const after = observation(
      [req("POST", "http://localhost:4173/api/payment-consistency", 500)],
      "Payment successful"
    );

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(false);
  });
});
