import type { ServerResponse } from "node:http";
import { createLogger } from "../../logger.js";
import { runPreflight, schemaFailureReport } from "../../preflight/doctor.js";
import { ProfileError } from "../../profiles/schema.js";
import type { ProfileStore } from "../../profiles/store.js";
import { profileToAppConfig } from "../../profiles/to-app-config.js";
import { sendJson } from "../http-helpers.js";

export async function handlePreflight(res: ServerResponse, profileStore: ProfileStore, profileId: string): Promise<void> {
  try {
    const profile = profileStore.load(profileId);
    const config = profileToAppConfig(profile);
    const report = await runPreflight(profile, config, createLogger());
    sendJson(res, 200, report);
  } catch (error) {
    if (error instanceof ProfileError) {
      sendJson(res, 200, schemaFailureReport(profileId, error.message));
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}
