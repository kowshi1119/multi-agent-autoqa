import { describe, expect, it } from "vitest";
import { checkClaims, firstContradiction } from "../../src/critic/claim-checks.js";
import type { CriticDecision, CriticInput } from "../../src/types.js";

function input(overrides: Partial<CriticInput> = {}): CriticInput {
  return {
    finding: { title: "t", category: "network", pathname: "/form", expected: "e", actual: "a" },
    evidenceLevel: "L1",
    reproduction: { attempts: 3, successes: 3 },
    oracle: { oracleId: "duplicate-request", suspicious: true, expected: "e", actual: "a" },
    evidence: {
      console: [],
      consoleScope: { totalCaptured: 0, included: 0, omitted: 0 },
      network: [],
      networkScope: { totalPageRequests: 5, matchedForTriggeringEndpoint: 2, included: 0, omitted: 0 },
      pageErrors: [],
      screenshotPaths: ["screenshot.png"],
      traceAvailable: true,
      attemptScope: { representativeAttempt: 1, totalAttempts: 3, completeness: "representative-success" },
    },
    environment: { targetEnvironment: "local-fixture", browser: "chromium", pathname: "/form" },
    ...overrides,
  };
}

function decision(overrides: Partial<CriticDecision> = {}): CriticDecision {
  return {
    verdict: "invalid",
    confidence: 0.8,
    summary: "s",
    evidenceReferences: [],
    missingEvidence: [],
    ...overrides,
  };
}

describe("checkClaims", () => {
  it("marks a real evidence file reference as supported", () => {
    const results = checkClaims(decision({ evidenceReferences: ["oracle.json", "screenshot.png"] }), input());
    expect(results.find((r) => r.claim === "evidenceReferences:oracle.json")?.status).toBe("supported");
    expect(results.find((r) => r.claim === "evidenceReferences:screenshot.png")?.status).toBe("supported");
  });

  it("marks an unrecognized evidence file reference as uncheckable, never contradicted", () => {
    const results = checkClaims(decision({ evidenceReferences: ["made-up-file.json"] }), input());
    expect(results[0]?.status).toBe("uncheckable");
  });

  it("marks a requirementConflict id that was actually scoped in as supported", () => {
    const results = checkClaims(
      decision({ requirementConflict: "REQ-001" }),
      input({ requirementContext: [{ id: "REQ-001", pathname: "/form", description: "d" }] })
    );
    expect(results.find((r) => r.claim.startsWith("requirementConflict"))?.status).toBe("supported");
  });

  it("marks a requirementConflict id that was never scoped in as contradicted", () => {
    const results = checkClaims(decision({ requirementConflict: "REQ-999" }), input({ requirementContext: [] }));
    expect(firstContradiction(results)?.claim).toBe("requirementConflict:REQ-999");
  });

  it("checks a claimed request count against matchedForTriggeringEndpoint, never total page traffic", () => {
    // networkScope.matchedForTriggeringEndpoint is 2 in the fixture, totalPageRequests is 5.
    const supported = checkClaims(decision({ summary: "Only two requests occurred." }), input());
    expect(supported.find((r) => r.claim.startsWith("claimedRequestCount"))?.status).toBe("supported");

    const contradicted = checkClaims(decision({ summary: "Only one request occurred." }), input());
    expect(firstContradiction(contradicted)?.claim).toBe("claimedRequestCount:1");
  });

  it("returns no claim checks at all when the decision makes no checkable claims", () => {
    const results = checkClaims(decision({ summary: "Looks like intended behavior.", evidenceReferences: [] }), input());
    expect(results).toEqual([]);
  });
});

describe("firstContradiction", () => {
  it("returns undefined when nothing is contradicted", () => {
    expect(firstContradiction([{ claim: "x", status: "supported", detail: "d" }])).toBeUndefined();
    expect(firstContradiction([{ claim: "x", status: "uncheckable", detail: "d" }])).toBeUndefined();
  });
});
