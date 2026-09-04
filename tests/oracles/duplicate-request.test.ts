import { describe, expect, it } from "vitest";
import { createDuplicateRequestOracle } from "../../src/oracles/duplicate-request.js";
import type { NetworkRecord, Observation, RecordedStep } from "../../src/types.js";
import { loadTestConfig } from "../helpers/test-config.js";

function observation(networkRequests: NetworkRecord[]): Observation {
  return {
    timestamp: new Date().toISOString(),
    page: { url: "http://localhost:4173/form", title: "Form", pathname: "/form" },
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

function post(): NetworkRecord {
  return { method: "POST", url: "http://localhost:4173/api/submit", status: 200, resourceType: "fetch", timestamp: new Date().toISOString() };
}

const step: RecordedStep = {
  number: 1,
  action: { type: "click", target: { role: "button", name: "Submit" } },
  timestamp: new Date().toISOString(),
};

describe("duplicate-request oracle", () => {
  it("does not flag a single matching POST (within expectedMax:1)", async () => {
    const oracle = createDuplicateRequestOracle(loadTestConfig());
    const before = observation([]);
    const after = observation([post()]);

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(false);
  });

  it("flags two matching POSTs against expectedMax:1", async () => {
    const oracle = createDuplicateRequestOracle(loadTestConfig());
    const before = observation([]);
    const after = observation([post(), post()]);

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(true);
    expect(result.oracleId).toBe("duplicate-request");
  });

  it("counts only newly occurring requests, not ones already present before the action", async () => {
    const oracle = createDuplicateRequestOracle(loadTestConfig());
    const before = observation([post()]);
    const after = observation([post(), post()]);

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(false);
  });

  it("ignores requests that do not match any configured pattern", async () => {
    const oracle = createDuplicateRequestOracle(loadTestConfig());
    const before = observation([]);
    const unrelated: NetworkRecord = {
      method: "GET",
      url: "http://localhost:4173/form",
      status: 200,
      resourceType: "document",
      timestamp: new Date().toISOString(),
    };
    const after = observation([unrelated, unrelated, unrelated]);

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(false);
  });
});
