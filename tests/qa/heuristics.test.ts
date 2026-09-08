import { describe, expect, it } from "vitest";
import { allHeuristics } from "../../src/qa/heuristics.js";
import { createH01EmptyInput } from "../../src/qa/heuristics/h01-empty-input.js";
import { createH10DoubleSubmission } from "../../src/qa/heuristics/h10-double-submission.js";
import type { InteractiveElement, Observation } from "../../src/types.js";
import { loadTestConfig } from "../helpers/test-config.js";

function el(partial: Partial<InteractiveElement>): InteractiveElement {
  return { widgetType: "unknown", visible: true, enabled: true, ...partial };
}

const observation: Observation = {
  timestamp: new Date().toISOString(),
  page: { url: "http://localhost:4173/form", title: "Form", pathname: "/form" },
  viewport: { width: 1440, height: 900 },
  visibleText: "",
  interactiveElements: [],
  forms: [],
  links: [],
  consoleMessages: [],
  pageErrors: [],
  networkRequests: [],
  dialogs: [],
  stateSignature: "irrelevant",
};

describe("QaHeuristic applicability", () => {
  it("H01 (empty input) applies to a text field", () => {
    const h = createH01EmptyInput();
    expect(h.isApplicable(observation, el({ role: "textbox", widgetType: "text_field" }))).toBe(true);
  });

  it("H01 (empty input) does not apply to a button", () => {
    const h = createH01EmptyInput();
    expect(h.isApplicable(observation, el({ role: "button", widgetType: "button" }))).toBe(false);
  });

  it("H01 (empty input) does not apply to a password field", () => {
    const h = createH01EmptyInput();
    expect(h.isApplicable(observation, el({ role: "textbox", widgetType: "password_field" }))).toBe(false);
  });

  it("H01 (empty input) does not apply to an invisible field", () => {
    const h = createH01EmptyInput();
    expect(h.isApplicable(observation, el({ role: "textbox", widgetType: "text_field", visible: false }))).toBe(
      false
    );
  });

  it("H10 (double submission) applies to a submit button only in local-fixture + safeMode", () => {
    const config = loadTestConfig();
    const h = createH10DoubleSubmission(config);
    expect(h.isApplicable(observation, el({ role: "button", widgetType: "submit_button" }))).toBe(true);
  });

  it("H10 (double submission) is disabled outside the local fixture", () => {
    const config = loadTestConfig((y) => y.replace('environment: "local-fixture"', 'environment: "staging"'));
    const h = createH10DoubleSubmission(config);
    expect(h.isApplicable(observation, el({ role: "button", widgetType: "submit_button" }))).toBe(false);
  });

  it("H10 (double submission) is disabled when safeMode is off", () => {
    const config = loadTestConfig((y) => y.replace("safeMode: true", "safeMode: false"));
    const h = createH10DoubleSubmission(config);
    expect(h.isApplicable(observation, el({ role: "button", widgetType: "submit_button" }))).toBe(false);
  });

  it("allHeuristics(config) returns exactly the 11 documented heuristics", () => {
    const config = loadTestConfig();
    const heuristics = allHeuristics(config);
    expect(heuristics.map((h) => h.id).sort()).toEqual([
      "H01",
      "H02",
      "H03",
      "H04",
      "H05",
      "H06",
      "H07",
      "H08",
      "H09",
      "H10",
      "H11",
    ]);
  });

  it("every heuristic declares an explicit risk", () => {
    const config = loadTestConfig();
    for (const h of allHeuristics(config)) {
      expect(["safe", "moderate", "destructive"]).toContain(h.risk);
    }
  });
});

describe("QaHeuristic buildTest", () => {
  it("H01 builds a fill action with an empty value", async () => {
    const h = createH01EmptyInput();
    const target = el({ role: "textbox", name: "Username", widgetType: "text_field" });
    const actions = await h.buildTest(observation, target);
    expect(actions).toEqual([{ type: "fill", target: { role: "textbox", name: "Username" }, value: "" }]);
  });
});
