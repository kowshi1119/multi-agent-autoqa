import { describe, expect, it } from "vitest";
import { decideStatus } from "../src/validator.js";

describe("decideStatus", () => {
  const minimumSuccesses = 2;

  it("validates when all attempts reproduce (3/3)", () => {
    expect(decideStatus(3, minimumSuccesses)).toBe("validated");
  });

  it("validates when exactly the minimum reproduces (2/3)", () => {
    expect(decideStatus(2, minimumSuccesses)).toBe("validated");
  });

  it("needs a human when below the minimum but above zero (1/3)", () => {
    expect(decideStatus(1, minimumSuccesses)).toBe("needs_human");
  });

  it("rejects when nothing reproduces (0/3)", () => {
    expect(decideStatus(0, minimumSuccesses)).toBe("rejected");
  });
});
