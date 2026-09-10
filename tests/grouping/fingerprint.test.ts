import { describe, expect, it } from "vitest";
import { fingerprintFinding, fingerprintKey } from "../../src/grouping/fingerprint.js";
import type { Finding } from "../../src/types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "FINDING-001",
    title: "t",
    status: "validated",
    category: "network",
    pageId: "PAGE-001",
    url: "http://localhost:4173/payment",
    pathname: "/payment",
    expected: "e",
    actual: "a",
    oracle: {
      oracleId: "http-failure",
      suspicious: true,
      expected: "e",
      actual: "a",
      details: { newFailures: [{ method: "POST", url: "http://localhost:4173/api/pay-fail", status: 500 }] },
    },
    steps: [],
    reproduction: { attempts: 3, successes: 3 },
    occurrenceCount: 1,
    evidence: ["oracle.json"],
    evidenceLevel: "L3",
    reportDisposition: "report",
    ...overrides,
  };
}

describe("fingerprintKey", () => {
  it("is identical for the same underlying failure reached via different controls (actionContext excluded from the key)", () => {
    const a = fingerprintFinding(finding({ id: "FINDING-001", controlKey: "spinbutton:Amount" }));
    const b = fingerprintFinding(finding({ id: "FINDING-002", controlKey: "button:Submit" }));
    expect(a.actionContext).not.toBe(b.actionContext);
    expect(fingerprintKey(a)).toBe(fingerprintKey(b));
  });

  it("differs for two distinct defects sharing the same oracle and page but different endpoints", () => {
    const a = fingerprintFinding(finding({ id: "FINDING-001" }));
    const b = fingerprintFinding(
      finding({
        id: "FINDING-002",
        oracle: {
          oracleId: "http-failure",
          suspicious: true,
          expected: "e",
          actual: "a",
          details: { newFailures: [{ method: "POST", url: "http://localhost:4173/api/other-endpoint", status: 500 }] },
        },
      })
    );
    expect(fingerprintKey(a)).not.toBe(fingerprintKey(b));
  });

  it("differs for two ui-api-consistency findings on the same page with different ruleIds", () => {
    const rule = (ruleId: string) => ({
      oracleId: "ui-api-consistency",
      suspicious: true,
      expected: "e",
      actual: "a",
      details: { ruleId, newFailures: [{ method: "POST", url: "http://localhost:4173/api/x", status: 500 }] },
    });
    const a = fingerprintFinding(finding({ id: "FINDING-001", oracle: rule("rule-a") }));
    const b = fingerprintFinding(finding({ id: "FINDING-002", oracle: rule("rule-b") }));
    expect(fingerprintKey(a)).not.toBe(fingerprintKey(b));
  });

  it("differs when requirementScope (surfaced from finding.critic.requirementConflict) differs", () => {
    const a = fingerprintFinding(finding({ id: "FINDING-001", critic: { verdict: "invalid", confidence: 0.8, summary: "s", provider: "mock", requirementConflict: "REQ-001" } }));
    const b = fingerprintFinding(finding({ id: "FINDING-002", critic: { verdict: "invalid", confidence: 0.8, summary: "s", provider: "mock", requirementConflict: "REQ-002" } }));
    expect(fingerprintKey(a)).not.toBe(fingerprintKey(b));
  });

  it("is stable across narrative-text differences that don't change the structural details", () => {
    const a = fingerprintFinding(finding({ id: "FINDING-001", actual: "A completely different narrative sentence, padded out well past two hundred characters so it would collide under a naive text-prefix comparison even though the underlying endpoint and status are identical in both findings." }));
    const b = fingerprintFinding(finding({ id: "FINDING-002" }));
    expect(fingerprintKey(a)).toBe(fingerprintKey(b));
  });

  it("differs for console-error findings with genuinely different error text, even though the oracle narrative field is identical", () => {
    const consoleFinding = (message: string) => ({
      oracleId: "console-error",
      suspicious: true,
      expected: "0 new unexpected error-level console messages",
      actual: "1 new unexpected error-level console message",
      details: { newErrors: [message] },
    });
    const a = fingerprintFinding(finding({ id: "FINDING-001", pathname: "/form", oracle: consoleFinding("Seeded QA defect") }));
    const b = fingerprintFinding(finding({ id: "FINDING-002", pathname: "/form", oracle: consoleFinding("A totally unrelated error") }));
    expect(fingerprintKey(a)).not.toBe(fingerprintKey(b));
  });
});
