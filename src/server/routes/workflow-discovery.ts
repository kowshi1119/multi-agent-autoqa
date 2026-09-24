import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { createLogger } from "../../logger.js";
import { runWorkflowDiscovery, validateDiscoveredWorkflow } from "../../pilot/workflow-discovery.js";
import { saveWorkflowManifest, type DeclaredWorkflow } from "../../pilot/workflow-manifest.js";
import { ProfileError } from "../../profiles/schema.js";
import type { ProfileStore } from "../../profiles/store.js";
import { credentialSecrets } from "../../redact.js";
import { readJsonBody, sendJson } from "../http-helpers.js";
import { isAuthDiscoveryActive, releaseDiscovery, tryAcquireDiscovery } from "./auth-discovery.js";

const credentialsSchema = z.object({ username: z.string().min(1).max(1000), password: z.string().min(1).max(1000) });
const saveSchema = z.object({ workflows: z.array(z.unknown()).min(1).max(10) });

/** Credentials exist only in `parsed.data` for the duration of the call -- never logged, stored or echoed. */
export async function handleWorkflowDiscovery(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore, profileId: string, runBusy: () => boolean): Promise<void> {
  let body: unknown;
  try { body = await readJsonBody(req); } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" }); return; }
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) { sendJson(res, 400, { error: "username and password are both required." }); return; }

  const controller = tryAcquireDiscovery(profileStore, runBusy);
  if (!controller) { sendJson(res, 409, { error: "Finish or stop the current run or discovery before starting another." }); return; }
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", disconnected);
  try {
    const profile = profileStore.load(profileId);
    const result = await runWorkflowDiscovery(profile, parsed.data, createLogger(undefined, credentialSecrets(parsed.data)), controller.signal);
    if (res.destroyed) return;
    if (result.status === "failed") { sendJson(res, 422, { error: result.reason }); return; }
    sendJson(res, 200, { startPathname: result.startPathname, candidates: result.candidates, skipped: result.skipped });
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
  if (!parsed.success) { sendJson(res, 400, { error: "Provide 1-10 workflows to save." }); return; }
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
