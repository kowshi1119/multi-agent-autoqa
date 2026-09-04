import { describe, expect, it } from "vitest";
import { explorerDecisionSchema, isOriginAllowed, qaActionSchema } from "../src/actions.js";

describe("qaActionSchema", () => {
  it("accepts a valid click action", () => {
    const result = qaActionSchema.safeParse({
      type: "click",
      target: { role: "button", name: "Submit" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unsupported action type", () => {
    const result = qaActionSchema.safeParse({
      type: "evaluate",
      script: "alert(1)",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a click target with no locator fields", () => {
    const result = qaActionSchema.safeParse({
      type: "click",
      target: {},
    });
    expect(result.success).toBe(false);
  });

  it("accepts a full explorer decision", () => {
    const result = explorerDecisionSchema.safeParse({
      candidateId: "H01|textbox:Username",
      testingIntent: "Test the form submission workflow",
      reason: "The form is the primary interactive workflow on this page.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an explorer decision missing a candidateId", () => {
    const result = explorerDecisionSchema.safeParse({
      testingIntent: "Test the form submission workflow",
      reason: "The form is the primary interactive workflow on this page.",
    });
    expect(result.success).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  const allowed = ["http://localhost:4173"];

  it("allows navigation within the configured origin", () => {
    expect(isOriginAllowed("http://localhost:4173/some/path", allowed)).toBe(true);
  });

  it("rejects navigation to an external origin", () => {
    expect(isOriginAllowed("https://evil.example.com", allowed)).toBe(false);
  });

  it("rejects an unparseable url", () => {
    expect(isOriginAllowed("not-a-url", allowed)).toBe(false);
  });
});
