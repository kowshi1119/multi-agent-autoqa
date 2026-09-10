import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadChallengeCorpus,
  loadOfflineFindings,
  validateChallengeCorpus,
} from "../../src/experiments/challenge-corpus.js";

const manifestPath = resolve("fixture", "challenge-corpus", "manifest.json");

describe("challenge corpus manifest", () => {
  it("loads and validates with no errors", () => {
    const manifest = loadChallengeCorpus(manifestPath);
    const errors = validateChallengeCorpus(manifest);
    expect(errors).toEqual([]);
  });

  it("has at least 12 distinct-defect and 8 non-defect cases", () => {
    const manifest = loadChallengeCorpus(manifestPath);
    const distinct = manifest.cases.filter((c) => c.label === "distinct-defect");
    const nonDefect = manifest.cases.filter((c) => c.label === "non-defect");
    expect(distinct.length).toBeGreaterThanOrEqual(12);
    expect(nonDefect.length).toBeGreaterThanOrEqual(8);
  });

  it("every offline-evidence-record case has a non-empty rationale (label-quality gate)", () => {
    const manifest = loadChallengeCorpus(manifestPath);
    const offline = manifest.cases.filter((c) => c.kind === "offline-evidence-record");
    expect(offline.length).toBeGreaterThan(0);
    for (const c of offline) {
      expect(c.rationale.trim().length).toBeGreaterThan(0);
      expect(c.offlineEvidence?.finding.id).toBeTruthy();
    }
  });

  it("every executable-fixture case references a real fixtureRef", () => {
    const manifest = loadChallengeCorpus(manifestPath);
    const executable = manifest.cases.filter((c) => c.kind === "executable-fixture");
    expect(executable.length).toBeGreaterThan(0);
    for (const c of executable) {
      expect(c.fixtureRef?.pathname).toBeTruthy();
      expect(c.fixtureRef?.oracleId).toBeTruthy();
    }
  });

  it("held-out cases sharing a splitGroup never straddle the boolean", () => {
    const manifest = loadChallengeCorpus(manifestPath);
    const byGroup = new Map<string, Set<boolean>>();
    for (const c of manifest.cases) {
      const set = byGroup.get(c.splitGroup) ?? new Set<boolean>();
      set.add(c.heldOut);
      byGroup.set(c.splitGroup, set);
    }
    for (const [, values] of byGroup) expect(values.size).toBe(1);
  });

  it("the near-duplicate-distinct pair (CC-009/CC-010) shares a splitGroup but has genuinely different failure signatures", () => {
    const manifest = loadChallengeCorpus(manifestPath);
    const a = manifest.cases.find((c) => c.id === "CC-009");
    const b = manifest.cases.find((c) => c.id === "CC-010");
    expect(a?.splitGroup).toBe(b?.splitGroup);
    expect(a?.offlineEvidence?.finding.oracle.details).not.toEqual(b?.offlineEvidence?.finding.oracle.details);
  });

  it("the genuine-duplicate pair (CC-011/CC-012) shares a splitGroup and the SAME underlying endpoint+status", () => {
    const manifest = loadChallengeCorpus(manifestPath);
    const a = manifest.cases.find((c) => c.id === "CC-011");
    const b = manifest.cases.find((c) => c.id === "CC-012");
    expect(a?.splitGroup).toBe(b?.splitGroup);
    const aFailure = (a?.offlineEvidence?.finding.oracle.details as { newFailures: Array<{ url: string; status: number }> })?.newFailures[0];
    const bFailure = (b?.offlineEvidence?.finding.oracle.details as { newFailures: Array<{ url: string; status: number }> })?.newFailures[0];
    expect(aFailure?.url).toBe(bFailure?.url);
    expect(aFailure?.status).toBe(bFailure?.status);
  });

  it("loadOfflineFindings returns a Finding[] for every offline-evidence-record case, none presented with a ground-truth id or evaluator label", () => {
    const manifest = loadChallengeCorpus(manifestPath);
    const findings = loadOfflineFindings(manifest);
    expect(findings.length).toBe(manifest.cases.filter((c) => c.kind === "offline-evidence-record").length);
    for (const finding of findings) {
      expect(JSON.stringify(finding).toLowerCase()).not.toContain("seed-0");
    }
  });

  it("a corpus with a distinct-defect count below the floor is flagged", () => {
    const manifest = loadChallengeCorpus(manifestPath);
    const truncated = { ...manifest, cases: manifest.cases.filter((c) => c.label !== "distinct-defect").concat(manifest.cases.find((c) => c.label === "distinct-defect")!) };
    const errors = validateChallengeCorpus(truncated);
    expect(errors.some((e) => e.includes("distinct-defect"))).toBe(true);
  });
});
