import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeStateSignature,
  controlKey,
  normalizePathname,
} from "../../src/mapping/state-signature.js";
import type { InteractiveElement } from "../../src/types.js";

function el(partial: Partial<InteractiveElement>): InteractiveElement {
  return { widgetType: "unknown", visible: true, ...partial };
}

describe("normalizePathname", () => {
  it("returns the pathname only, ignoring query and fragment", () => {
    expect(normalizePathname("http://localhost:4173/form?x=1#frag")).toBe("/form");
  });

  it("normalizes an empty pathname to /", () => {
    expect(normalizePathname("http://localhost:4173")).toBe("/");
  });

  it("preserves case", () => {
    expect(normalizePathname("http://localhost:4173/Account")).toBe("/Account");
  });

  it("returns / for an unparseable URL", () => {
    expect(normalizePathname("not-a-url")).toBe("/");
  });
});

describe("controlKey", () => {
  it("uses role:name when an accessible name exists", () => {
    expect(controlKey({ role: "button", name: "Submit", label: "ignored" })).toBe("button:Submit");
  });

  it("falls back to role:label when no name exists", () => {
    expect(controlKey({ role: "textbox", label: "Username" })).toBe("textbox:Username");
  });

  it("falls back to role: with empty value when neither exists", () => {
    expect(controlKey({ role: "textbox" })).toBe("textbox:");
  });
});

describe("computeStateSignature", () => {
  it("matches the pinned sha256(pathname|sortedControlKeys|visibleText[:300]) formula exactly", () => {
    const controls = [el({ role: "textbox", name: "Username" }), el({ role: "button", name: "Submit" })];
    const visibleText = "Welcome to the form page.";
    const expectedInput = `/form|button:Submit,textbox:Username|${visibleText}`;
    const expectedHash = createHash("sha256").update(expectedInput, "utf-8").digest("hex");

    expect(computeStateSignature("/form", controls, visibleText)).toBe(expectedHash);
  });

  it("deduplicates identical control keys before hashing", () => {
    const controls = [el({ role: "button", name: "Submit" }), el({ role: "button", name: "Submit" })];
    const withDupe = computeStateSignature("/form", controls, "text");
    const withoutDupe = computeStateSignature("/form", [controls[0] as InteractiveElement], "text");
    expect(withDupe).toBe(withoutDupe);
  });

  it("truncates visible text to 300 characters for the hash input", () => {
    const long = "a".repeat(400);
    const truncated = "a".repeat(300);
    expect(computeStateSignature("/form", [], long)).toBe(computeStateSignature("/form", [], truncated));
  });

  it("is not affected by query strings baked into the pathname argument (caller must normalize first)", () => {
    // computeStateSignature trusts its `pathname` argument as already-normalized;
    // this test documents that contract rather than re-testing normalizePathname.
    expect(computeStateSignature("/form", [], "x")).not.toBe(computeStateSignature("/form?x=1", [], "x"));
  });
});
