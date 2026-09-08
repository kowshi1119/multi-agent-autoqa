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

  // Phase 3 A1 acceptance test: before the fix, the "disabled" branch
  // returned "report" unconditionally, before the L6 check (which only
  // lived inside the "decided" branch) ever ran. L6 must be a ceiling
  // across every critic outcome kind, not just "decided".
  it("L6 evidence + critic disabled -> needs_human (L6 ceiling applies even when the critic never ran)", () => {
    const result = decideDisposition({ validationStatus: "validated", evidenceLevel: "L6", criticOutcome: { kind: "disabled" } });
    expect(result).toEqual({ reportDisposition: "needs_human", criticEvidenceConflict: false });
  });

  it("L6 evidence + contradiction -> needs_human, and still preserves criticEvidenceConflict:true (the naive top-level-hoist regression this fix must avoid)", () => {
    const result = decideDisposition({
      validationStatus: "validated",
      evidenceLevel: "L6",
      criticOutcome: { kind: "contradiction", reason: "CRITIC_EVIDENCE_CONTRADICTION: ..." },
    });
    expect(result).toEqual({ reportDisposition: "needs_human", criticEvidenceConflict: true });
  });

  it("L6 evidence + skipped/unavailable -> needs_human, conflict:false (already true, now regression-locked)", () => {
    expect(
      decideDisposition({ validationStatus: "validated", evidenceLevel: "L6", criticOutcome: { kind: "skipped" } })
    ).toEqual({ reportDisposition: "needs_human", criticEvidenceConflict: false });
    expect(
      decideDisposition({
        validationStatus: "validated",
        evidenceLevel: "L6",
        criticOutcome: { kind: "unavailable", reason: "timeout" },
      })
    ).toEqual({ reportDisposition: "needs_human", criticEvidenceConflict: false });
  });

  describe("full policy matrix: validationStatus=validated x evidenceLevel x criticOutcome.kind", () => {
    const evidenceLevels: EvidenceLevel[] = ["L1", "L2", "L3", "L6"];
    const outcomes: Array<{ label: string; outcome: CriticOutcome }> = [
      { label: "disabled", outcome: { kind: "disabled" } },
      { label: "skipped", outcome: { kind: "skipped" } },
      { label: "unavailable", outcome: { kind: "unavailable", reason: "x" } },
      { label: "contradiction", outcome: { kind: "contradiction", reason: "x" } },
      { label: "decided-valid", outcome: decided("valid") },
      { label: "decided-invalid", outcome: decided("invalid") },
      { label: "decided-needs_human", outcome: decided("needs_human") },
    ];

    function expected(evidenceLevel: EvidenceLevel, label: string): { reportDisposition: string; criticEvidenceConflict: boolean } {
      if (label === "disabled") {
        return evidenceLevel === "L6"
          ? { reportDisposition: "needs_human", criticEvidenceConflict: false }
          : { reportDisposition: "report", criticEvidenceConflict: false };
      }
      if (label === "skipped" || label === "unavailable") {
        return { reportDisposition: "needs_human", criticEvidenceConflict: false };
      }
      if (label === "contradiction") {
        return { reportDisposition: "needs_human", criticEvidenceConflict: true };
      }
      if (label === "decided-valid") {
        return evidenceLevel === "L6"
          ? { reportDisposition: "needs_human", criticEvidenceConflict: false }
          : { reportDisposition: "report", criticEvidenceConflict: false };
      }
      if (label === "decided-invalid") {
        if (evidenceLevel === "L1") return { reportDisposition: "needs_human", criticEvidenceConflict: true };
        return { reportDisposition: "suppress", criticEvidenceConflict: false };
      }
      // decided-needs_human
      return { reportDisposition: "needs_human", criticEvidenceConflict: false };
    }

    for (const evidenceLevel of evidenceLevels) {
      for (const { label, outcome } of outcomes) {
        it(`evidenceLevel=${evidenceLevel} outcome=${label}`, () => {
          const result = decideDisposition({ validationStatus: "validated", evidenceLevel, criticOutcome: outcome });
          expect(result).toEqual(expected(evidenceLevel, label));
        });
      }
    }
  });
});
