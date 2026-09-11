import type { ServerResponse } from "node:http";
import { ProfileError } from "../../profiles/schema.js";
import type { ProfileStore } from "../../profiles/store.js";
import { sendJson } from "../http-helpers.js";

/**
 * Returns the ordinary-user-facing fields only -- a profile never carries
 * a secret (see schema.ts), so nothing needs stripping here, but the
 * shape is deliberately explicit rather than `JSON.stringify`ing whatever
 * the schema happens to contain, so a future profile field addition can't
 * silently start reaching the client.
 */
export function handleListProfiles(res: ServerResponse, profileStore: ProfileStore): void {
  try {
    const profiles = profileStore.list().map((p) => ({
      id: p.id,
      name: p.name,
      environmentKind: p.target.environmentKind,
      authMode: p.auth.mode,
      limits: p.limits,
    }));
    sendJson(res, 200, { profiles });
  } catch (error) {
    const message = error instanceof ProfileError ? error.message : "Failed to list profiles";
    sendJson(res, 500, { error: message });
  }
}
