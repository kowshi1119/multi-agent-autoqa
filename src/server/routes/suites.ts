import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { assertExpectedTarget, expectedTargetSchema, TargetChangedError } from "../../profiles/fingerprint.js";
import { ProfileError } from "../../profiles/schema.js";
import type { ProfileStore } from "../../profiles/store.js";
import { approveBaseline, baselineEligibility, currentBaseline, loadBaselines } from "../../suites/baselines.js";
import { readSuiteResult, readSuiteRunSnapshot } from "../../suites/result.js";
import { availableItems, findSuite, loadSuites, saveSuite, SUITE_ID_RE, SuiteError, suiteContentHash, suiteInputSchema, validateSuite } from "../../suites/suite-manifest.js";
import { readJsonBody, sendJson } from "../http-helpers.js";
import { resolveArtifactPath } from "../security.js";

const PROFILE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Suites, their validation status and baseline, and the saved items a suite may select. Reads only local files. */
export function handleListSuites(res: ServerResponse, profileStore: ProfileStore, profileId: string): void {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  try {
    const profile = profileStore.load(profileId);
    const baselines = loadBaselines(profileStore.getDir(), profileId);
    const suites = loadSuites(profileStore.getDir(), profileId).suites.map((suite) => {
      const validation = validateSuite(profileStore, profileId, suite);
      const baseline = baselines.suites[suite.id]?.current;
      return {
        ...suite,
        contentHash: suiteContentHash(suite),
        valid: validation.ok,
        errors: validation.ok ? [] : validation.errors,
        baseline: baseline ? { runId: baseline.runId, suiteRevision: baseline.suiteRevision, approvedAt: baseline.approvedAt, note: baseline.note ?? null } : null,
        baselineHistory: (baselines.suites[suite.id]?.history ?? []).map((b) => ({ runId: b.runId, suiteRevision: b.suiteRevision, approvedAt: b.approvedAt })),
      };
    });
    const limits = { maxActions: profile.limits.maxActions, maxDurationMs: profile.limits.maxDurationMs, maxApiRequests: profile.limits.maxApiRequests ?? profile.limits.maxActions };
    sendJson(res, 200, { suites, availableItems: availableItems(profileStore.getDir(), profile), profileLimits: limits });
  } catch (error) {
    if (error instanceof ProfileError) { sendJson(res, 404, { error: error.message }); return; }
    if (error instanceof SuiteError) { sendJson(res, 400, { error: error.message, errors: error.errors }); return; }
    throw error;
  }
}

const saveSuiteSchema = z.object({ suite: suiteInputSchema, expected: expectedTargetSchema }).strict();

export async function handleSaveSuite(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore, profileId: string): Promise<void> {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  let body: unknown;
  try { body = await readJsonBody(req); } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" }); return; }
  const parsed = saveSuiteSchema.safeParse(body);
  if (!parsed.success) { sendJson(res, 400, { error: "Invalid suite.", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }); return; }
  try {
    assertExpectedTarget(profileStore, profileId, parsed.data.expected);
    const suite = saveSuite(profileStore, profileId, parsed.data.suite);
    sendJson(res, 200, { suite: { ...suite, contentHash: suiteContentHash(suite) } });
  } catch (error) {
    if (error instanceof TargetChangedError) { sendJson(res, 409, { error: error.message, code: "TARGET_CHANGED" }); return; }
    if (error instanceof SuiteError) { sendJson(res, 400, { error: error.message, errors: error.errors, code: "SUITE_INVALID" }); return; }
    if (error instanceof ProfileError) { sendJson(res, 404, { error: error.message }); return; }
    throw error;
  }
}

/** A suite run's result, its comparison and whether it may become the baseline (with a plain-language reason). */
export function handleSuiteRun(res: ServerResponse, profileStore: ProfileStore, runsRoot: string, runId: string, active: boolean): void {
  const runDir = resolveArtifactPath(runsRoot, runId, ".");
  if (!runDir) { sendJson(res, 404, { error: "Unknown run" }); return; }
  const snapshot = readSuiteRunSnapshot(runDir);
  if (!snapshot) { sendJson(res, 404, { error: "Not a suite run" }); return; }
  const result = readSuiteResult(runDir);
  const comparisonPath = join(runDir, "suite-comparison.json");
  const comparison = existsSync(comparisonPath) ? JSON.parse(readFileSync(comparisonPath, "utf-8")) as unknown : null;
  let eligibility: { eligible: boolean; reason?: string; replaceRequired?: boolean; currentBaselineRunId?: string | null } = { eligible: false, reason: active ? "The run is still in progress." : "The suite result was not recorded." };
  if (result && !active) {
    try {
      const suite = findSuite(profileStore.getDir(), snapshot.profileId, snapshot.suite.id);
      const e = baselineEligibility(runsRoot, runId, snapshot.profileId, suite);
      const current = currentBaseline(profileStore.getDir(), snapshot.profileId, suite.id);
      eligibility = e.eligible
        ? current?.runId === runId ? { eligible: false, reason: "This run is the approved baseline.", currentBaselineRunId: current.runId } : { eligible: true, replaceRequired: Boolean(current), currentBaselineRunId: current?.runId ?? null }
        : { eligible: false, reason: e.reason, currentBaselineRunId: current?.runId ?? null };
    } catch (error) {
      eligibility = { eligible: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  sendJson(res, 200, { snapshot, result: result ?? null, comparison, baselineEligibility: eligibility });
}

const approveSchema = z.object({ suiteId: z.string().regex(SUITE_ID_RE), replace: z.boolean().optional(), note: z.string().max(500).optional() }).strict();

export async function handleApproveBaseline(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore, runsRoot: string, runId: string, activeRunId: string | undefined): Promise<void> {
  let body: unknown;
  try { body = await readJsonBody(req); } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" }); return; }
  const parsed = approveSchema.safeParse(body);
  if (!parsed.success) { sendJson(res, 400, { error: "Invalid baseline approval." }); return; }
  if (activeRunId === runId) { sendJson(res, 409, { error: "The run is still in progress." }); return; }
  const runDir = resolveArtifactPath(runsRoot, runId, ".");
  const snapshot = runDir ? readSuiteRunSnapshot(runDir) : undefined;
  if (!runDir || !snapshot) { sendJson(res, 404, { error: "That run does not exist or was not a suite run." }); return; }
  if (snapshot.suite.id !== parsed.data.suiteId) { sendJson(res, 409, { error: "That run executed a different suite." }); return; }
  try {
    const suite = findSuite(profileStore.getDir(), snapshot.profileId, parsed.data.suiteId);
    const baseline = approveBaseline(profileStore.getDir(), runsRoot, snapshot.profileId, suite, suiteContentHash(suite), runId, { ...(parsed.data.replace ? { replace: true } : {}), ...(parsed.data.note ? { note: parsed.data.note } : {}) });
    sendJson(res, 200, { baseline: { runId: baseline.runId, suiteId: baseline.suiteId, suiteRevision: baseline.suiteRevision, approvedAt: baseline.approvedAt } });
  } catch (error) {
    if (error instanceof SuiteError) { sendJson(res, 409, { error: error.message }); return; }
    throw error;
  }
}
