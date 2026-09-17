import type { IncomingMessage, ServerResponse } from "node:http";
import { parseProfile, ProfileError } from "../../profiles/schema.js";
import type { ProfileStore } from "../../profiles/store.js";
import { readJsonBody, sendJson } from "../http-helpers.js";

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
      // Confirmed Phase 4 continuation gap: the profile list previously
      // omitted provider/model identity entirely, so a user couldn't see
      // which provider a profile would actually use without opening its
      // underlying JSON file.
      provider: {
        explorer: { provider: p.provider.explorer.provider, model: p.provider.explorer.model },
        critic: { enabled: p.provider.critic.enabled, provider: p.provider.critic.provider, model: p.provider.critic.model },
      },
    }));
    sendJson(res, 200, { profiles });
  } catch (error) {
    const message = error instanceof ProfileError ? error.message : "Failed to list profiles";
    sendJson(res, 500, { error: message });
  }
}

/**
 * Full profile document -- used only to pre-fill the edit form. A profile
 * never carries a secret (see schema.ts), so returning it verbatim is safe.
 */
export function handleGetProfile(res: ServerResponse, profileStore: ProfileStore, id: string): void {
  try {
    const profile = profileStore.load(id);
    sendJson(res, 200, { profile });
  } catch (error) {
    if (error instanceof ProfileError) {
      sendJson(res, 404, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Failed to load profile" });
  }
}

/**
 * Create-or-edit, both through one endpoint: parseProfile() validates the
 * full document (the same authoritative check every other profile-reading
 * path already goes through), then ProfileStore.save() writes it -- a save
 * with an existing id overwrites, which is exactly "edit"; there's no
 * separate update path to keep in sync. ProfileStore.save() already
 * redacts defensively before writing, though a profile never contains a
 * secret by schema construction.
 */
export async function handleSaveProfile(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" });
    return;
  }

  try {
    const profile = parseProfile(body);
    profileStore.save(profile);
    sendJson(res, 200, { profile });
  } catch (error) {
    if (error instanceof ProfileError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Failed to save profile" });
  }
}
