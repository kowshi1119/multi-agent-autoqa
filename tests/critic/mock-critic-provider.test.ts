import { describe, expect, it } from "vitest";
import { MockCriticProvider } from "../../src/critic/mock-critic-provider.js";
import type { CriticInput } from "../../src/types.js";

function input(overrides: Partial<CriticInput> = {}): CriticInput {
  return {
    finding: { title: "t", category: "network", pathname: "/payment", expected: "e", actual: "a" },
    evidenceLevel: "L3",
    reproduction: { attempts: 3, successes: 3 },
    oracle: { oracleId: "http-failure", suspicious: true, expected: "e", actual: "a" },
    evidence: { console: [], network: [], pageErrors: [], screenshotPaths: [], traceAvailable: false },
    environment: { targetEnvironment: "local-fixture", browser: "chromium", pathname: "/payment" },
    ...overrides,
  };
}

describe("MockCriticProvider", () => {
  const critic = new MockCriticProvider();

  it("always returns needs_human for L6 evidence, regardless of reproduction strength", async () => {
    const decision = await critic.critique(input({ evidenceLevel: "L6" }));
    expect(decision.verdict).toBe("needs_human");
  });

  it("returns invalid when observed evidence matches a scoped requirement", async () => {
    const decision = await critic.critique(
      input({
        evidenceLevel: "L1",
        oracle: { oracleId: "ui-api-consistency", suspicious: true, expected: "e", actual: "a" },
        requirementContext: [
          {
            id: "REQ-001",
            pathname: "/payment",
            description: "Simulated outage shows a known-limitation message.",
            triggerRequestPathname: "/api/simulated-outage",
            expectedVisibleText: "Service temporarily unavailable",
          },
        ],
        evidence: {
          console: [],
          network: [{ method: "POST", pathname: "/api/simulated-outage", status: 500 }],
          pageErrors: [],
          screenshotPaths: [],
          traceAvailable: false,
          uiTextExcerpt: "Service temporarily unavailable. Please try again later.",
        },
      })
    );
    expect(decision.verdict).toBe("invalid");
    expect(decision.requirementConflict).toBe("REQ-001");
  });

  it("does not match a requirement scoped to a different pathname", async () => {
    const decision = await critic.critique(
      input({
        evidenceLevel: "L3",
        requirementContext: [
          { id: "REQ-001", pathname: "/other-page", description: "Unrelated requirement." },
        ],
      })
    );
    expect(decision.verdict).toBe("valid");
  });

  it("returns valid for strong L1 reproducible evidence with no matching requirement", async () => {
    const decision = await critic.critique(
      input({ evidenceLevel: "L1", oracle: { oracleId: "duplicate-request", suspicious: true, expected: "e", actual: "a" } })
    );
    expect(decision.verdict).toBe("valid");
  });

  it("returns valid for strong L3 reproducible evidence with no matching requirement", async () => {
    const decision = await critic.critique(input({ evidenceLevel: "L3", reproduction: { attempts: 3, successes: 3 } }));
    expect(decision.verdict).toBe("valid");
  });

  it("returns needs_human when reproduction is weak", async () => {
    const decision = await critic.critique(input({ evidenceLevel: "L3", reproduction: { attempts: 3, successes: 1 } }));
    expect(decision.verdict).toBe("needs_human");
  });

  it("never reads finding.id or ground truth -- CriticInput has no such fields by construction", async () => {
    const decision = await critic.critique(input());
    expect(decision).not.toHaveProperty("findingId");
  });
});
