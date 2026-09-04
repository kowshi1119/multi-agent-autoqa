import { describe, expect, it } from "vitest";
import { createConsoleErrorOracle } from "../../src/oracles/console-error.js";
import type { Observation, RecordedStep } from "../../src/types.js";
import { loadTestConfig } from "../helpers/test-config.js";

function observation(consoleErrors: string[]): Observation {
  return {
    timestamp: new Date().toISOString(),
    page: { url: "http://localhost:4173/", title: "AutoQA Fixture", pathname: "/" },
    viewport: { width: 1440, height: 900 },
    visibleText: "",
    interactiveElements: [],
    forms: [],
    links: [],
    consoleMessages: consoleErrors.map((text) => ({ type: "error", text, timestamp: new Date().toISOString() })),
    pageErrors: [],
    networkRequests: [],
    dialogs: [],
    stateSignature: "irrelevant",
  };
}

const step: RecordedStep = {
  number: 1,
  action: { type: "click", target: { role: "button", name: "Submit" } },
  timestamp: new Date().toISOString(),
};

describe("console-error oracle", () => {
  it("flags a newly introduced console error as suspicious", async () => {
    const oracle = createConsoleErrorOracle(loadTestConfig());
    const result = await oracle.evaluate(observation([]), step, observation(["Seeded QA defect"]));

    expect(result.suspicious).toBe(true);
    expect(result.oracleId).toBe("console-error");
  });

  it("does not flag a pre-existing error that persists unchanged", async () => {
    const oracle = createConsoleErrorOracle(loadTestConfig());
    const result = await oracle.evaluate(
      observation(["Known existing error"]),
      step,
      observation(["Known existing error"])
    );

    expect(result.suspicious).toBe(false);
  });

  it("flags a new error even when a known error also persists", async () => {
    const oracle = createConsoleErrorOracle(loadTestConfig());
    const result = await oracle.evaluate(
      observation(["Known existing error"]),
      step,
      observation(["Known existing error", "Seeded QA defect"])
    );

    expect(result.suspicious).toBe(true);
    expect(result.details?.["newErrors"]).toEqual(["Seeded QA defect"]);
  });

  it("never flags an error matching a configured ignore pattern", async () => {
    const config = loadTestConfig((y) => y.replace("ignorePatterns: []", 'ignorePatterns: ["favicon\\\\.ico"]'));
    const oracle = createConsoleErrorOracle(config);
    const result = await oracle.evaluate(
      observation([]),
      step,
      observation(["Failed to load resource: favicon.ico"])
    );

    expect(result.suspicious).toBe(false);
  });
});
