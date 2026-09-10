import { describe, expect, it } from "vitest";
import { detectEvidenceContradiction } from "../../src/critic/contradiction-check.js";
import type { CriticDecision, CriticInput } from "../../src/types.js";

function input(networkCount: number): CriticInput {
  return {
    finding: { title: "t", category: "network", pathname: "/form", expected: "e", actual: "a" },
    evidenceLevel: "L1",
    reproduction: { attempts: 3, successes: 3 },
    oracle: { oracleId: "duplicate-request", suspicious: true, expected: "e", actual: "a" },
    evidence: {
      console: [],
      consoleScope: { totalCaptured: 0, included: 0, omitted: 0 },
      network: Array.from({ length: networkCount }, () => ({ method: "POST", pathname: "/api/submit", status: 200 })),
      networkScope: { totalPageRequests: networkCount, matchedForTriggeringEndpoint: networkCount, included: networkCount, omitted: 0 },
      pageErrors: [],
      screenshotPaths: [],
      traceAvailable: false,
      attemptScope: { representativeAttempt: 1, totalAttempts: 3, completeness: "representative-success" },
    },
    environment: { targetEnvironment: "local-fixture", browser: "chromium", pathname: "/form" },
  };
}

function decision(summary: string, alternativeExplanation?: string): CriticDecision {
  return {
    verdict: "invalid",
    confidence: 0.8,
    summary,
    evidenceReferences: [],
    missingEvidence: [],
    ...(alternativeExplanation ? { alternativeExplanation } : {}),
  };
}

describe("detectEvidenceContradiction", () => {
  it("returns null when the critic makes no numeric request-count claim", () => {
    expect(detectEvidenceContradiction(decision("Looks like intended retry behavior."), input(2))).toBeNull();
  });

  it("returns null when the critic's claimed count matches the evidence", () => {
    expect(detectEvidenceContradiction(decision("Only one request occurred."), input(1))).toBeNull();
  });

  it("flags a contradiction when the critic claims fewer requests than the evidence shows", () => {
    const reason = detectEvidenceContradiction(decision("Only one request occurred, this is expected."), input(2));
    expect(reason).toContain("CRITIC_EVIDENCE_CONTRADICTION");
    expect(reason).toContain("claimed 1");
    expect(reason).toContain("shows 2");
  });

  it("understands word-form numbers as well as digits", () => {
    const reason = detectEvidenceContradiction(decision("Only two requests occurred."), input(3));
    expect(reason).toContain("claimed 2");
  });

  it("checks alternativeExplanation as well as summary", () => {
    const reason = detectEvidenceContradiction(decision("No issue found.", "Only one request was made."), input(2));
    expect(reason).toContain("CRITIC_EVIDENCE_CONTRADICTION");
  });
});
