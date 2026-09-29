import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveArtifactPath } from "../server/security.js";
import { readSuiteResult, readSuiteRunSnapshot, type SuiteResult } from "./result.js";
import { SUITE_ID_RE, SuiteError, type Suite } from "./suite-manifest.js";

/**
 * Explicitly approved suite baselines, kept in `profiles/<id>.baselines.json`
 * (git-ignored with the other local profile files). A baseline is a copy of
 * a passing run's `suite-result.json` plus approval metadata; the run
 * directory itself is never modified. Nothing replaces a baseline except an
 * explicit approval with `replace: true`, and the previous one is kept in
 * `history`.
 */
export type Baseline = {
  runId: string;
  profileId: string;
  suiteId: string;
  suiteRevision: number;
  suiteContentHash: string;
  target: SuiteResult["target"];
  executionSettings: SuiteResult["executionSettings"];
  items: SuiteResult["items"];
  decision: SuiteResult["decision"];
  approvedAt: string;
  approvedBy: "local user";
  note?: string;
};
type BaselinesFile = { schemaVersion: 1; profileId: string; suites: Record<string, { current: Baseline; history: Baseline[] }> };

const baselinesFileSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  suites: z.record(z.string().regex(SUITE_ID_RE), z.object({ current: z.record(z.unknown()), history: z.array(z.record(z.unknown())).max(50) })),
});

const path = (profilesDir: string, profileId: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(profileId)) throw new SuiteError("Invalid profile ID");
  return join(profilesDir, `${profileId}.baselines.json`);
};

export function loadBaselines(profilesDir: string, profileId: string): BaselinesFile {
  const file = path(profilesDir, profileId);
  if (!existsSync(file)) return { schemaVersion: 1, profileId, suites: {} };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf-8")); } catch { throw new SuiteError(`${profileId}.baselines.json is not valid JSON`); }
  const parsed = baselinesFileSchema.safeParse(raw);
  if (!parsed.success || parsed.data.profileId !== profileId) throw new SuiteError(`${profileId}.baselines.json is invalid or belongs to another profile`);
  return parsed.data as unknown as BaselinesFile;
}

export function currentBaseline(profilesDir: string, profileId: string, suiteId: string): Baseline | undefined {
  return loadBaselines(profilesDir, profileId).suites[suiteId]?.current;
}

export type Eligibility = { eligible: true; result: SuiteResult } | { eligible: false; reason: string };

/** Plain-language reasons; the UI shows them verbatim next to a disabled "Approve as baseline" button. */
export function baselineEligibility(runsRoot: string, runId: string, profileId: string, suite: Suite): Eligibility {
  const runDir = resolveArtifactPath(runsRoot, runId, ".");
  if (!runDir) return { eligible: false, reason: "That run does not exist." };
  const snapshot = readSuiteRunSnapshot(runDir);
  const result = readSuiteResult(runDir);
  if (!snapshot || !result) return { eligible: false, reason: "That run was not a suite run, or its suite result was not recorded." };
  if (snapshot.profileId !== profileId || result.profileId !== profileId) return { eligible: false, reason: "That run belongs to a different application." };
  if (snapshot.suite.id !== suite.id || result.suite.id !== suite.id) return { eligible: false, reason: "That run executed a different suite." };
  if (result.runStatus === "cancelled") return { eligible: false, reason: "This run was cancelled, so it can't be a passing baseline." };
  if (result.runStatus !== "completed") return { eligible: false, reason: `This run did not complete (status: ${result.runStatus}), so it can't be a passing baseline.` };
  if (result.decision === "FAIL") return { eligible: false, reason: "A required item failed in this run, so it can't be a passing baseline." };
  if (result.decision !== "PASS") return { eligible: false, reason: "Required coverage is incomplete in this run (items not executed or unsupported), so it can't be a passing baseline." };
  if (snapshot.suite.revision !== suite.revision || snapshot.suite.contentHash !== result.suite.contentHash) return { eligible: false, reason: `This run used suite revision ${snapshot.suite.revision}; the suite is now at revision ${suite.revision}. Run the current revision and approve that run.` };
  return { eligible: true, result };
}

export function approveBaseline(
  profilesDir: string,
  runsRoot: string,
  profileId: string,
  suite: Suite,
  currentContentHash: string,
  runId: string,
  options: { replace?: boolean; note?: string } = {},
  now = new Date()
): Baseline {
  const eligibility = baselineEligibility(runsRoot, runId, profileId, suite);
  if (!eligibility.eligible) throw new SuiteError(eligibility.reason);
  const { result } = eligibility;
  if (result.suite.contentHash !== currentContentHash) throw new SuiteError("The suite changed after this run; run the current revision and approve that run.");
  const file = loadBaselines(profilesDir, profileId);
  const existing = file.suites[suite.id];
  if (existing?.current.runId === runId) throw new SuiteError("This run is already the approved baseline.");
  if (existing && !options.replace) throw new SuiteError(`Suite "${suite.name}" already has an approved baseline (${existing.current.runId}). Confirm replacement to approve a different run.`);
  const baseline: Baseline = {
    runId,
    profileId,
    suiteId: suite.id,
    suiteRevision: result.suite.revision,
    suiteContentHash: result.suite.contentHash,
    target: result.target,
    executionSettings: result.executionSettings,
    items: result.items,
    decision: result.decision,
    approvedAt: now.toISOString(),
    approvedBy: "local user",
    ...(options.note ? { note: options.note.slice(0, 500) } : {}),
  };
  file.suites[suite.id] = { current: baseline, history: existing ? [existing.current, ...existing.history].slice(0, 50) : [] };
  const target = path(profilesDir, profileId);
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(`${target}.tmp`, JSON.stringify(file, null, 2), "utf-8");
  renameSync(`${target}.tmp`, target);
  return baseline;
}
