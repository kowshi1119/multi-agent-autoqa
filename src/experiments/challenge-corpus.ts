import { readFileSync } from "node:fs";
import type { Finding } from "../types.js";

export type ChallengeCorpusVersion = 1;
export type ChallengeCorpusCaseKind = "executable-fixture" | "offline-evidence-record";
export type ChallengeCorpusCaseLabel = "distinct-defect" | "non-defect";
export type ChallengeCorpusScenarioTag =
  | "expected-failure"
  | "unrelated-background-traffic"
  | "stale-success-text"
  | "flaky-reproduction"
  | "insufficient-evidence"
  | "near-duplicate-distinct"
  | "genuine-duplicate";

/**
 * `label` (distinct-defect / non-defect) is what counts toward the
 * spec's >=12/>=8 size floor. `scenarioTags` captures the qualitative
 * category (near-duplicate-distinct, genuine-duplicate, flaky
 * reproduction, etc.) separately, since a near-duplicate-distinct pair is
 * still two individually genuine "distinct-defect" cases relative to
 * each other, not a third counting bucket.
 */
export type ChallengeCorpusCase = {
  id: string;
  kind: ChallengeCorpusCaseKind;
  label: ChallengeCorpusCaseLabel;
  scenarioTags: ChallengeCorpusScenarioTag[];
  description: string;
  /** e.g. "authored for Phase 3" / "reuses fixture SEED-001" -- never presented as an autonomous discovery. */
  provenance: string;
  /** WHY this label was assigned -- stored here, separate from runtime requirements.json, never reachable by Planner/Explorer/Oracles/Validator/Critic. */
  rationale: string;
  fixtureRef?: { pathname: string; oracleId: string };
  offlineEvidence?: { finding: Finding };
  /** Groups related manifestations (a near-duplicate or genuine-duplicate pair) into the SAME split. */
  splitGroup: string;
  heldOut: boolean;
};

export type ChallengeCorpusManifest = { corpusVersion: ChallengeCorpusVersion; cases: ChallengeCorpusCase[] };

export function loadChallengeCorpus(path: string): ChallengeCorpusManifest {
  return JSON.parse(readFileSync(path, "utf-8")) as ChallengeCorpusManifest;
}

/** Every offline-evidence-record case's Finding, ready to feed into runCondition/matchFindingsV2 without ever touching a browser -- and never presented as an autonomous discovery in any report. */
export function loadOfflineFindings(manifest: ChallengeCorpusManifest): Finding[] {
  return manifest.cases
    .filter((c): c is ChallengeCorpusCase & { offlineEvidence: { finding: Finding } } => c.kind === "offline-evidence-record" && Boolean(c.offlineEvidence))
    .map((c) => c.offlineEvidence.finding);
}

export function validateChallengeCorpus(manifest: ChallengeCorpusManifest): string[] {
  const errors: string[] = [];

  const distinctDefects = manifest.cases.filter((c) => c.label === "distinct-defect");
  const nonDefects = manifest.cases.filter((c) => c.label === "non-defect");
  if (distinctDefects.length < 12) errors.push(`expected >=12 distinct-defect cases, found ${distinctDefects.length}`);
  if (nonDefects.length < 8) errors.push(`expected >=8 non-defect cases, found ${nonDefects.length}`);

  for (const c of manifest.cases) {
    if (!c.rationale.trim()) errors.push(`${c.id}: rationale must not be empty`);
    if (c.kind === "offline-evidence-record" && !c.offlineEvidence) {
      errors.push(`${c.id}: offline-evidence-record case is missing offlineEvidence`);
    }
    if (c.kind === "executable-fixture" && !c.fixtureRef) {
      errors.push(`${c.id}: executable-fixture case is missing fixtureRef`);
    }
  }

  const splitGroupHeldOut = new Map<string, Set<boolean>>();
  for (const c of manifest.cases) {
    const set = splitGroupHeldOut.get(c.splitGroup) ?? new Set<boolean>();
    set.add(c.heldOut);
    splitGroupHeldOut.set(c.splitGroup, set);
  }
  for (const [group, values] of splitGroupHeldOut) {
    if (values.size > 1) errors.push(`splitGroup "${group}" has members split across heldOut true/false`);
  }

  return errors;
}
