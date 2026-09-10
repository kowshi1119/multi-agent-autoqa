import { describe, expect, it, vi } from "vitest";

// Hoisted mock: importing phase2-experiment.js must never actually start
// the fixture server, regardless of what its own main() would otherwise
// do -- this is what makes the assertion below meaningful even if some
// other guard (module-level side effect, a changed condition, etc.)
// accidentally reintroduces the bug this test exists to catch.
vi.mock("../fixture/server.js", () => ({
  startFixtureServer: vi.fn(),
}));

describe("phase2-experiment.ts module import (Phase 3 A3 regression)", () => {
  it("importing the module for its exported helpers triggers no browser/fixture-server side effect", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { startFixtureServer } = await import("../fixture/server.js");

    // A plain `import` (not `node dist/src/phase2-experiment.js` on the
    // command line) must never satisfy isMainModule()'s guard -- confirm
    // by importing the already-compiled module the same way any other
    // test file would.
    await import("../src/phase2-experiment.js");

    expect(startFixtureServer).not.toHaveBeenCalled();
    expect(
      consoleLogSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("AutoQA Phase 2 — False-Positive-Challenge Experiment")
      )
    ).toBe(false);

    consoleLogSpy.mockRestore();
  });
});
