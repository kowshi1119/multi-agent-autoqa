import { describe, expect, it } from "vitest";
import { decideDisposition } from "../../src/critic/disposition.js";
import type { CriticOutcome } from "../../src/critic/disposition.js";
import type { EvidenceLevel } from "../../src/types.js";

function decided(verdict: "valid" | "invalid" | "needs_human"): CriticOutcome {
  return {
    kind: "decided",
    decision: { verdict, confidence: 0.8, summary: "s", evidenceReferences: [], missingEvidence: [] },
  };
}

describe("decideDisposition", () => {
  it("rejected validation status -> suppress, regardless of critic outcome", () => {
    const result = decideDisposition({ validationStatus: "rejected", evidenceLevel: "L3", criticOutcome: { kind: "skipped" } });
    expect(result).toEqual({ reportDisposition: "suppress", criticEvidenceConflict: false });
  });

  it("needs_human validation status -> needs_human, regardless of critic outcome", () => {
    const result = decideDisposition({ validationStatus: "needs_human", evidenceLevel: "L3", criticOutcome: { kind: "skipped" } });
    expect(result.reportDisposition).toBe("needs_human");
  });

  it("critic disabled (Condition-A parity) -> report", () => {
    const result = decideDisposition({ validationStatus: "validated", evidenceLevel: "L3", criticOutcome: { kind: "disabled" } });
    expect(result).toEqual({ reportDisposition: "report", criticEvidenceConflict: false });
  });

  it("critic skipped -> needs_human (conservative default)", () => {
    const result = decideDisposition({ validationStatus: "validated", evidenceLevel: "L3", criticOutcome: { kind: "skipped" } });
    expect(result.reportDisposition).toBe("needs_human");
  });

  it("critic unavailable -> needs_human (conservative default)", () => {
    const result = decideDisposition({
      validationStatus: "validated",
      evidenceLevel: "L3",
      criticOutcome: { kind: "unavailable", reason: "CRITIC_MODEL_ERROR: timeout" },
    });
    expect(result.reportDisposition).toBe("needs_human");
  });

  it("evidence contradiction -> needs_human + conflict flag", () => {
    const result = decideDisposition({
      validationStatus: "validated",
      evidenceLevel: "L3",
      criticOutcome: { kind: "contradiction", reason: "CRITIC_EVIDENCE_CONTRADICTION: ..." },
    });
    expect(result).toEqual({ reportDisposition: "needs_human", criticEvidenceConflict: true });
  });

  it("L6 evidence + valid verdict -> needs_human (L6 can never auto-report)", () => {
    const result = decideDisposition({ validationStatus: "validated", evidenceLevel: "L6", criticOutcome: decided("valid") });
    expect(result.reportDisposition).toBe("needs_human");
  });

  it("L1 evidence + invalid verdict -> needs_human + conflict (invariant vs critic disagreement)", () => {
    const result = decideDisposition({ validationStatus: "validated", evidenceLevel: "L1", criticOutcome: decided("invalid") });
    expect(result).toEqual({ reportDisposition: "needs_human", criticEvidenceConflict: true });
  });

  it("decided valid (non-L1/L6) -> report", () => {
    const result = decideDisposition({ validationStatus: "validated", evidenceLevel: "L3", criticOutcome: decided("valid") });
    expect(result).toEqual({ reportDisposition: "report", criticEvidenceConflict: false });
  });

  it("decided invalid (non-L1) -> suppress", () => {
    const result = decideDisposition({ validationStatus: "validated", evidenceLevel: "L3", criticOutcome: decided("invalid") });
    expect(result).toEqual({ reportDisposition: "suppress", criticEvidenceConflict: false });
  });

  it("decided needs_human -> needs_human", () => {
    const result = decideDisposition({ validationStatus: "validated", evidenceLevel: "L3", criticOutcome: decided("needs_human") });
    expect(result.reportDisposition).toBe("needs_human");
  });

  it("L1 evidence + valid verdict -> report (invariant and critic agree)", () => {
    const evidenceLevel: EvidenceLevel = "L1";
    const result = decideDisposition({ validationStatus: "validated", evidenceLevel, criticOutcome: decided("valid") });
    expect(result).toEqual({ reportDisposition: "report", criticEvidenceConflict: false });
  });
});
