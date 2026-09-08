import { describe, expect, it } from "vitest";
import { createH11SafeControl } from "../../src/qa/heuristics/h11-safe-control.js";
import type { InteractiveElement, Observation } from "../../src/types.js";
import { loadTestConfig } from "../helpers/test-config.js";

function el(partial: Partial<InteractiveElement>): InteractiveElement {
  return { widgetType: "unknown", visible: true, enabled: true, ...partial };
}

const observation: Observation = {
  timestamp: new Date().toISOString(),
  page: { url: "http://localhost:4173/account", title: "Account", pathname: "/account" },
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

describe("H11 (safe control activation)", () => {
  it("applies to a plain button in the local fixture", () => {
    const h = createH11SafeControl(loadTestConfig());
    expect(h.isApplicable(observation, el({ role: "button", widgetType: "button", name: "View Profile" }))).toBe(true);
  });

  it("does not apply to a submit_button (H10's territory)", () => {
    const h = createH11SafeControl(loadTestConfig());
    expect(h.isApplicable(observation, el({ role: "button", widgetType: "submit_button", name: "Save" }))).toBe(false);
  });

  it("does not apply when the control's name looks destructive", () => {
    const h = createH11SafeControl(loadTestConfig());
    expect(h.isApplicable(observation, el({ role: "button", widgetType: "button", name: "Delete Account" }))).toBe(
      false
    );
  });

  it("does not apply when heuristics.safeControlClick.enabled is false", () => {
    const config = loadTestConfig((y) => y.replace("safeControlClick:\n    enabled: true", "safeControlClick:\n    enabled: false"));
    const h = createH11SafeControl(config);
    expect(h.isApplicable(observation, el({ role: "button", widgetType: "button", name: "View Profile" }))).toBe(
      false
    );
  });

  it("does not apply outside the local fixture unless the control is allowlisted", () => {
    const config = loadTestConfig((y) => y.replace('environment: "local-fixture"', 'environment: "staging"'));
    const h = createH11SafeControl(config);
    expect(h.isApplicable(observation, el({ role: "button", widgetType: "button", name: "View Profile" }))).toBe(
      false
    );
  });

  it("applies outside the local fixture when the control is explicitly allowlisted by name", () => {
    const config = loadTestConfig((y) =>
      y
        .replace('environment: "local-fixture"', 'environment: "staging"')
        .replace("allowedControls: []", 'allowedControls: ["View Profile"]')
    );
    const h = createH11SafeControl(config);
    expect(h.isApplicable(observation, el({ role: "button", widgetType: "button", name: "View Profile" }))).toBe(
      true
    );
  });

  it("does not apply when safeMode is off, even in the local fixture", () => {
    const config = loadTestConfig((y) => y.replace("safeMode: true", "safeMode: false"));
    const h = createH11SafeControl(config);
    expect(h.isApplicable(observation, el({ role: "button", widgetType: "button", name: "View Profile" }))).toBe(
      false
    );
  });

  it("buildTest produces a single click on the target control", async () => {
    const h = createH11SafeControl(loadTestConfig());
    const target = el({ role: "button", widgetType: "button", name: "View Profile" });
    const actions = await h.buildTest(observation, target);
    expect(actions).toEqual([{ type: "click", target: { role: "button", name: "View Profile" } }]);
  });
});
