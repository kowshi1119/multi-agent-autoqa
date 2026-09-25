import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { createLogger } from "../../logger.js";
import { runWorkflowDiscovery, validateDiscoveredWorkflow } from "../../pilot/workflow-discovery.js";
import { saveWorkflowManifest, type DeclaredWorkflow } from "../../pilot/workflow-manifest.js";
import { assertExpectedTarget, expectedTargetSchema, TargetChangedError } from "../../profiles/fingerprint.js";
import { ProfileError } from "../../profiles/schema.js";
import type { ProfileStore } from "../../profiles/store.js";
import { credentialSecrets } from "../../redact.js";
import { readJsonBody, sendJson } from "../http-helpers.js";
import { isAuthDiscoveryActive, releaseDiscovery, tryAcquireDiscovery } from "./auth-discovery.js";

const discoverySchema = z.object({ username: z.string().min(1).max(1000), password: z.string().min(1).max(1000), expected: expectedTargetSchema }).strict();
const saveSchema = z.object({ workflows: z.array(z.unknown()).min(1).max(10), expected: expectedTargetSchema }).strict();

/** Rejects (and returns true) when the prepared target no longer matches the stored configuration -- before any browser launch or write. */
function rejectStaleTarget(res: ServerResponse, profileStore: ProfileStore, profileId: string, expected: z.infer<typeof expectedTargetSchema>): boolean {
  try {
    assertExpectedTarget(profileStore, profileId, expected);
    return false;
  } catch (error) {
    if (error instanceof TargetChangedError) { sendJson(res, 409, { error: error.message, code: "TARGET_CHANGED" }); return true; }
    if (error instanceof ProfileError) { sendJson(res, 404, { error: error.message }); return true; }
    throw error;
  }
}

/** Credentials exist only in `credentials` for the duration of the call -- never logged, stored or echoed. */
export async function handleWorkflowDiscovery(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore, profileId: string, runBusy: () => boolean): Promise<void> {
  let body: unknown;
  try { body = await readJsonBody(req); } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" }); return; }
  const parsed = discoverySchema.safeParse(body);
  if (!parsed.success) { sendJson(res, 400, { error: "Username, password and a prepared target (check setup first) are required. Nothing was sent." }); return; }
  if (rejectStaleTarget(res, profileStore, profileId, parsed.data.expected)) return;
  const credentials = { username: parsed.data.username, password: parsed.data.password };

  const controller = tryAcquireDiscovery(profileStore, runBusy);
  if (!controller) { sendJson(res, 409, { error: "Finish or stop the current run or discovery before starting another." }); return; }
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", disconnected);
  try {
    const profile = profileStore.load(profileId);
    const result = await runWorkflowDiscovery(profile, credentials, createLogger(undefined, credentialSecrets(credentials)), controller.signal);
    if (res.destroyed) return;
    if (result.status === "failed") { sendJson(res, 422, { error: result.reason }); return; }
    sendJson(res, 200, { startPathname: result.startPathname, candidates: result.candidates, skipped: result.skipped, needsConfiguration: result.needsConfiguration });
  } catch (error) {
    if (res.destroyed) return;
    if (error instanceof ProfileError) { sendJson(res, 404, { error: error.message }); return; }
    sendJson(res, 500, { error: "Workflow discovery failed. Nothing was saved." });
  } finally {
    res.off("close", disconnected);
    releaseDiscovery(profileStore, controller);
  }
}

/** Saves user-confirmed drafts after re-validating every one server-side; rejects the whole request if any draft is invalid. */
export async function handleSaveWorkflows(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore, profileId: string, runBusy: () => boolean): Promise<void> {
  if (runBusy() || isAuthDiscoveryActive(profileStore)) { sendJson(res, 409, { error: "Wait for the current run or discovery to finish before saving workflows." }); return; }
  let body: unknown;
  try { body = await readJsonBody(req); } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" }); return; }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) { sendJson(res, 400, { error: "Provide 1-10 workflows and the prepared target." }); return; }
  if (rejectStaleTarget(res, profileStore, profileId, parsed.data.expected)) return;
  try {
    const profile = profileStore.load(profileId);
    const accepted: DeclaredWorkflow[] = [];
    for (const raw of parsed.data.workflows) {
      const result = validateDiscoveredWorkflow(profile, raw);
      if (!result.ok) { sendJson(res, 400, { error: result.reason }); return; }
      accepted.push(result.workflow);
    }
    const manifest = saveWorkflowManifest(profileStore.getDir(), profile.id, accepted);
    sendJson(res, 200, { saved: accepted.map((w) => w.id), workflows: manifest.workflows.length });
  } catch (error) {
    if (error instanceof ProfileError) { sendJson(res, 404, { error: error.message }); return; }
    sendJson(res, 500, { error: "Workflows could not be saved." });
  }
}
