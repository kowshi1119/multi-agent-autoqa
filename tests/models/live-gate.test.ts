import { describe, expect, it } from "vitest";
import { assertLiveModeAuthorized, LiveModeNotAuthorizedError } from "../../src/models/live-gate.js";

function models(explorerProvider: string, critic: { enabled: boolean; provider: string }) {
  return { models: { explorer: { provider: explorerProvider }, critic } };
}

describe("assertLiveModeAuthorized (Phase 4 continuation live-execution gating)", () => {
  it("allows a fully mock configuration with no --live flag at all", () => {
    expect(() => assertLiveModeAuthorized(models("mock", { enabled: true, provider: "mock" }), [])).not.toThrow();
  });

  it("allows a disabled critic with a live provider name configured (never actually called)", () => {
    expect(() => assertLiveModeAuthorized(models("mock", { enabled: false, provider: "anthropic" }), [])).not.toThrow();
  });

  it("refuses a live explorer provider without --live", () => {
    expect(() => assertLiveModeAuthorized(models("anthropic", { enabled: false, provider: "mock" }), [])).toThrow(
      LiveModeNotAuthorizedError
    );
  });

  it("refuses explorer:\"auto\" without --live -- auto may itself resolve to a real provider", () => {
    expect(() => assertLiveModeAuthorized(models("auto", { enabled: false, provider: "mock" }), [])).toThrow(LiveModeNotAuthorizedError);
  });

  it("refuses an enabled live critic without --live, independent of the explorer", () => {
    expect(() => assertLiveModeAuthorized(models("mock", { enabled: true, provider: "explabs" }), [])).toThrow(
      LiveModeNotAuthorizedError
    );
  });

  it("allows a live configuration once --live is present in argv", () => {
    expect(() => assertLiveModeAuthorized(models("anthropic", { enabled: true, provider: "anthropic" }), ["--live"])).not.toThrow();
  });

  it("the error message names which role(s) are live and never claims an env key is authorization", () => {
    try {
      assertLiveModeAuthorized(models("anthropic", { enabled: true, provider: "explabs" }), []);
      throw new Error("expected assertLiveModeAuthorized to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LiveModeNotAuthorizedError);
      const message = (error as Error).message;
      expect(message).toContain("explorer=anthropic");
      expect(message).toContain("critic=explabs");
      expect(message).toContain("--live");
      expect(message).toContain("not authorization by itself");
    }
  });

  it("defaults to reading process.argv when no argv is supplied", () => {
    const original = process.argv;
    try {
      process.argv = [...original.filter((a) => a !== "--live")];
      expect(() => assertLiveModeAuthorized(models("anthropic", { enabled: false, provider: "mock" }))).toThrow(
        LiveModeNotAuthorizedError
      );
      process.argv = [...process.argv, "--live"];
      expect(() => assertLiveModeAuthorized(models("anthropic", { enabled: false, provider: "mock" }))).not.toThrow();
    } finally {
      process.argv = original;
    }
  });
});
