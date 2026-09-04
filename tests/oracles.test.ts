import { describe, expect, it } from "vitest";
import { ConsoleErrorOracle } from "../src/oracles.js";
import type { Observation, RecordedStep } from "../src/types.js";

function observation(consoleErrors: string[]): Observation {
  return {
    timestamp: new Date().toISOString(),
    page: { url: "http://localhost:4173/", title: "AutoQA Fixture", pathname: "/" },
    viewport: { width: 1440, height: 900 },
    visibleText: "",
    interactiveElements: [],
    forms: [],
    links: [],
    consoleMessages: consoleErrors.map((text) => ({
      type: "error",
      text,
      timestamp: new Date().toISOString(),
    })),
    pageErrors: [],
    networkRequests: [],
    dialogs: [],
    stateSignature: "irrelevant-for-oracle-test",
  };
}

const step: RecordedStep = {
  number: 1,
  action: { type: "click", target: { role: "button", name: "Submit" } },
  timestamp: new Date().toISOString(),
};

describe("ConsoleErrorOracle", () => {
  it("flags a newly introduced console error as suspicious", async () => {
    const oracle = new ConsoleErrorOracle();
    const before = observation([]);
    const after = observation(["Seeded QA defect"]);

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(true);
    expect(result.oracleId).toBe("console-error");
  });

  it("does not flag a pre-existing error that persists unchanged", async () => {
    const oracle = new ConsoleErrorOracle();
    const before = observation(["Known existing error"]);
    const after = observation(["Known existing error"]);

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(false);
  });

  it("flags a new error even when a known error also persists", async () => {
    const oracle = new ConsoleErrorOracle();
    const before = observation(["Known existing error"]);
    const after = observation(["Known existing error", "Seeded QA defect"]);

    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(true);
    expect(result.details?.["newErrors"]).toEqual(["Seeded QA defect"]);
  });
});
