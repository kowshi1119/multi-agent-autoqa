import type { ServerResponse } from "node:http";
import { createLogger } from "../../logger.js";
import { runPreflight, schemaFailureReport } from "../../preflight/doctor.js";
import { loadWorkflowManifest } from "../../pilot/workflow-manifest.js";
import { ProfileError } from "../../profiles/schema.js";
import type { ProfileStore } from "../../profiles/store.js";
import { profileToAppConfig } from "../../profiles/to-app-config.js";
import { sendJson } from "../http-helpers.js";

export async function handlePreflight(res: ServerResponse, profileStore: ProfileStore, profileId: string): Promise<void> {
  try {
    const profile = profileStore.load(profileId);
    const config = profileToAppConfig(profile);
    // Unfiltered -- the true declared-workflow count for this profile, not
    // scoped to any particular not-yet-started run's own selection (see
    // run-manager.ts's own runPreflight() call for that narrower case).
    const workflowManifest = loadWorkflowManifest(profileStore.getDir(), profile.id);
    const report = await runPreflight(profile, config, createLogger(), workflowManifest);
    sendJson(res, 200, report);
  } catch (error) {
    if (error instanceof ProfileError) {
      sendJson(res, 200, schemaFailureReport(profileId, error.message));
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}
