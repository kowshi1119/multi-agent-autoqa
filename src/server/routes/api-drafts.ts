import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ChecksManifestError, consistencyCheckSchema, consistencyProblems, loadChecksManifest, saveApiChecks, saveConsistencyCheck } from "../../checks/checks-manifest.js";
import { buildObservedDrafts, ObservedDraftError, observedSelectionSchema, proposeAssertions, readObservation } from "../../checks/observed-drafts.js";
import { scopedCheckUrl } from "../../checks/request-scope.js";
import { assertExpectedTarget, expectedTargetSchema, TargetChangedError } from "../../profiles/fingerprint.js";
import { ProfileError } from "../../profiles/schema.js";
import type { ProfileStore } from "../../profiles/store.js";
import { readJsonBody, sendJson } from "../http-helpers.js";

/**
 * Observation → check drafts. Reading and drafting contact nothing.
 * Approval re-derives every draft on the server from the stored
 * observation (client-edited drafts are never trusted), refuses stale,
 * cross-application or non-executable drafts, and saves nothing unless
 * every selected draft is executable. Enabling API checks for the profile
 * is a separate, explicit flag in the same request.
 */
const PROFILE_ID_RE = /^[A-Za-z0-9_-]+$/;
const runIdField = z.string().regex(/^RUN-[A-Za-z0-9-]{1,80}$/);
const draftSchema = z.object({ runId: runIdField, selections: z.array(observedSelectionSchema).min(1).max(20) }).strict();
const approveSchema = draftSchema.extend({
  observationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expected: expectedTargetSchema,
  enableApiChecks: z.boolean().default(false),
}).strict();

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof ObservedDraftError) { sendJson(res, error.code === "not-found" ? 404 : error.code === "invalid" ? 422 : 409, { error: error.message, code: error.code }); return; }
  if (error instanceof TargetChangedError) { sendJson(res, 409, { error: error.message, code: "TARGET_CHANGED" }); return; }
  if (error instanceof ProfileError) { sendJson(res, 404, { error: error.message }); return; }
  throw error;
}

/** The sanitized observation summary for one run of this application. */
export function handleGetObservations(res: ServerResponse, profileStore: ProfileStore, runsRoot: string, profileId: string, runId: string): void {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  try {
    profileStore.load(profileId);
    const stored = readObservation(runsRoot, runId);
    if (stored.observations.profileId !== profileId) throw new ObservedDraftError("That observation was recorded for a different application.", "cross-profile");
    const endpoints = stored.observations.endpoints.map((e) => ({ ...e, proposedAssertions: proposeAssertions(e) }));
    sendJson(res, 200, { observation: { ...stored.observations, endpoints }, observationSha256: stored.sha256 });
  } catch (error) { fail(res, error); }
}

function derive(profileStore: ProfileStore, runsRoot: string, profileId: string, runId: string, selections: z.infer<typeof observedSelectionSchema>[]) {
  const profile = profileStore.load(profileId);
  const origin = new URL(profile.target.url).origin;
  const stored = readObservation(runsRoot, runId);
  return { profile, stored, drafts: buildObservedDrafts(stored, profileId, origin, selections, (pathname) => Boolean(scopedCheckUrl(profile, origin, pathname))) };
}

async function body<S extends z.ZodTypeAny>(req: IncomingMessage, res: ServerResponse, schema: S): Promise<z.infer<S> | undefined> {
  let raw: unknown;
  try { raw = await readJsonBody(req); } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" }); return undefined; }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) { sendJson(res, 400, { error: "Invalid observation draft request.", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }); return undefined; }
  return parsed.data;
}

export async function handleObservedDrafts(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore, runsRoot: string, profileId: string): Promise<void> {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  const data = await body(req, res, draftSchema);
  if (!data) return;
  try {
    const { drafts, stored } = derive(profileStore, runsRoot, profileId, data.runId, data.selections);
    sendJson(res, 200, { drafts, observationSha256: stored.sha256 });
  } catch (error) { fail(res, error); }
}

export async function handleApproveObservedDrafts(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore, runsRoot: string, profileId: string, runBusy: () => boolean): Promise<void> {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  const data = await body(req, res, approveSchema);
  if (!data) return;
  if (runBusy()) { sendJson(res, 409, { error: "Finish or stop the current run before changing approved checks." }); return; }
  try {
    assertExpectedTarget(profileStore, profileId, data.expected);
    const { profile, stored, drafts } = derive(profileStore, runsRoot, profileId, data.runId, data.selections);
    if (stored.sha256 !== data.observationSha256) throw new ObservedDraftError("The observation changed since these drafts were prepared. Review the drafts again; nothing was saved.", "stale");
    const blocked = drafts.filter((d) => !d.executable || !d.check);
    if (blocked.length) { sendJson(res, 422, { error: "Some selected drafts cannot be approved; nothing was saved.", drafts }); return; }
    saveApiChecks(profileStore.getDir(), profileId, drafts.map((d) => d.check!));
    if (data.enableApiChecks && !(profile.apiChecks.enabled && profile.apiChecks.useRunSession)) {
      profileStore.save({ ...profile, apiChecks: { ...profile.apiChecks, enabled: true, useRunSession: true } });
    }
    sendJson(res, 200, { saved: drafts.map((d) => d.check!.id), apiChecksEnabled: data.enableApiChecks || (profile.apiChecks.enabled && profile.apiChecks.useRunSession) });
  } catch (error) { fail(res, error); }
}

/** Newest runs of this application that recorded an API observation (local files only). */
export function handleListObservationRuns(res: ServerResponse, profileStore: ProfileStore, runsRoot: string, profileId: string): void {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  try {
    profileStore.load(profileId);
    const runIds = existsSync(runsRoot) ? readdirSync(runsRoot).filter((d) => /^RUN-[A-Za-z0-9-]{1,80}$/.test(d) && existsSync(join(runsRoot, d, "api-observations.json"))).sort().reverse() : [];
    const runs: Array<{ runId: string; endpoints: number; drain: string }> = [];
    for (const runId of runIds) {
      if (runs.length >= 20) break;
      try {
        const stored = readObservation(runsRoot, runId);
        if (stored.observations.profileId === profileId) runs.push({ runId, endpoints: stored.observations.endpoints.length, drain: stored.observations.drain });
      } catch { continue; } // older or unreadable observations are not offered
    }
    sendJson(res, 200, { runs });
  } catch (error) { fail(res, error); }
}

const consistencySaveSchema = z.object({ check: consistencyCheckSchema, expected: expectedTargetSchema }).strict();

/** Saves one UI–API comparison after validating it against the approved checks and saved workflows. Contacts nothing. */
export async function handleSaveConsistency(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore, profileId: string, runBusy: () => boolean, workflowIds: (profileId: string) => string[]): Promise<void> {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  const data = await body(req, res, consistencySaveSchema);
  if (!data) return;
  if (runBusy()) { sendJson(res, 409, { error: "Finish or stop the current run before changing approved checks." }); return; }
  try {
    assertExpectedTarget(profileStore, profileId, data.expected);
    const manifest = loadChecksManifest(profileStore.getDir(), profileId);
    const problems = consistencyProblems(data.check, manifest?.apiChecks ?? []);
    if (!workflowIds(profileId).includes(data.check.workflowId)) problems.push(`Workflow ${data.check.workflowId} is not a saved workflow of this application.`);
    if (problems.length) { sendJson(res, 422, { error: "The comparison cannot be saved; nothing was changed.", problems }); return; }
    saveConsistencyCheck(profileStore.getDir(), profileId, data.check);
    sendJson(res, 200, { saved: data.check.id });
  } catch (error) {
    if (error instanceof ChecksManifestError) { sendJson(res, 422, { error: error.message }); return; }
    fail(res, error);
  }
}
