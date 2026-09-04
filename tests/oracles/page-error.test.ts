import { describe, expect, it } from "vitest";
import { createPageErrorOracle } from "../../src/oracles/page-error.js";
import type { Observation, RecordedStep } from "../../src/types.js";

function observation(pageErrors: string[]): Observation {
  return {
    timestamp: new Date().toISOString(),
    page: { url: "http://localhost:4173/account", title: "Account", pathname: "/account" },
    viewport: { width: 1440, height: 900 },
    visibleText: "",
    interactiveElements: [],
    forms: [],
    links: [],
    consoleMessages: [],
    pageErrors: pageErrors.map((message) => ({ message, timestamp: new Date().toISOString() })),
    networkRequests: [],
    dialogs: [],
    stateSignature: "irrelevant",
  };
}

const step: RecordedStep = {
  number: 1,
  action: { type: "click", target: { role: "button", name: "View Profile" } },
  timestamp: new Date().toISOString(),
};

describe("page-error oracle", () => {
  it("flags a newly introduced uncaught runtime error as suspicious", async () => {
    const oracle = createPageErrorOracle();
    const result = await oracle.evaluate(observation([]), step, observation(["TypeError: x is null"]));

    expect(result.suspicious).toBe(true);
    expect(result.oracleId).toBe("page-error");
  });

  it("does not flag a pre-existing page error that persists unchanged", async () => {
    const oracle = createPageErrorOracle();
    const result = await oracle.evaluate(
      observation(["TypeError: x is null"]),
      step,
      observation(["TypeError: x is null"])
    );

    expect(result.suspicious).toBe(false);
  });

  it("is independent of console errors (only reads pageErrors)", async () => {
    const oracle = createPageErrorOracle();
    const before: Observation = { ...observation([]), consoleMessages: [] };
    const after: Observation = {
      ...observation([]),
      consoleMessages: [{ type: "error", text: "some console error", timestamp: new Date().toISOString() }],
    };
    const result = await oracle.evaluate(before, step, after);

    expect(result.suspicious).toBe(false);
  });
});
