import { describe, expect, it } from "vitest";
import { buildDisplayTitle, buildFindingTitle } from "../src/report.js";

describe("finding display titles", () => {
  it("names the actual trigger without changing the stored oracle title", () => {
    expect(buildFindingTitle("console-error")).toBe("New browser console error appears after form submission");
    expect(buildDisplayTitle("console-error", [{ type: "click", target: { role: "link" } }])).toBe("New browser console error appears after a link click");
    expect(buildDisplayTitle("console-error", [{ type: "fill", target: { role: "textbox" } }, { type: "click", target: { role: "button" } }])).toBeUndefined();
    expect(buildDisplayTitle("console-error", [{ type: "navigate" }])).toBe("New browser console error appears after an interaction");
    expect(buildDisplayTitle("page-error", [{ type: "click", target: { role: "link" } }])).toBeUndefined();
    expect(buildDisplayTitle("console-error", undefined)).toBeUndefined();
  });
});
