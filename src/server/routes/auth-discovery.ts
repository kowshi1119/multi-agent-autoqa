import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { runAuthDiscovery } from "../../auth/discovery.js";
import { createLogger } from "../../logger.js";
import { credentialSecrets } from "../../redact.js";
import { ProfileError } from "../../profiles/schema.js";
import { assertExpectedTarget, expectedTargetSchema, TargetChangedError } from "../../profiles/fingerprint.js";
import type { ProfileStore } from "../../profiles/store.js";
import { readJsonBody, sendJson } from "../http-helpers.js";

const discoveryRequestSchema = z.object({
  username: z.string().min(1).max(1000),
  password: z.string().min(1).max(1000),
  expected: expectedTargetSchema,
}).strict();

/**
 * One lock for every browser-driving discovery (authentication and
 * workflow): at most one per ProfileStore, and never alongside a run.
 * RunManager.startRun() checks isAuthDiscoveryActive() in its own
 * synchronous lock prelude, and tryAcquireDiscovery() checks runBusy() in
 * the same synchronous step that takes the lock, so neither side can slip
 * in between the other's check and set.
 */
const active = new WeakMap<ProfileStore, AbortController>();
export function isAuthDiscoveryActive(store: ProfileStore): boolean { return active.has(store); }
export function stopAuthDiscovery(store: ProfileStore): void { active.get(store)?.abort(); }
export function tryAcquireDiscovery(store: ProfileStore, runBusy: () => boolean): AbortController | undefined {
  if (active.has(store) || runBusy()) return undefined;
  const controller = new AbortController();
  active.set(store, controller);
  return controller;
}
export function releaseDiscovery(store: ProfileStore, controller: AbortController): void {
  if (active.get(store) === controller) active.delete(store);
}

/**
 * Transient by construction: `parsed.data` (the only place the raw
 * credential exists) is passed straight into runAuthDiscovery() and never
 * touches this function again -- nothing here logs, stores, or echoes it
 * back. See src/auth/discovery.ts's own doc comment for why this path
 * exists and what it deliberately does not do (never writes
 * authentication.json, never sets checksVerified itself).
 */
export async function handleAuthDiscovery(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore, profileId: string, runBusy: () => boolean = () => false): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" });
    return;
  }

  const parsed = discoveryRequestSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: "Username, password and a prepared target (check setup first) are required. Nothing was sent." });
    return;
  }
  try {
    assertExpectedTarget(profileStore, profileId, parsed.data.expected);
  } catch (error) {
    if (error instanceof TargetChangedError) { sendJson(res, 409, { error: error.message, code: "TARGET_CHANGED" }); return; }
    if (error instanceof ProfileError) { sendJson(res, 404, { error: error.message }); return; }
    throw error;
  }
  const credentials = { username: parsed.data.username, password: parsed.data.password };

  const controller = tryAcquireDiscovery(profileStore, runBusy);
  if (!controller) {
    sendJson(res, 409, { error: "Finish or stop the current run or discovery before starting another." });
    return;
  }
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", disconnected);
  try {
    const profile = profileStore.load(profileId);
    const result = await runAuthDiscovery(profile, credentials, createLogger(undefined, credentialSecrets(credentials)), controller.signal);
    if (res.destroyed) return;
    if (result.status === "failed") {
      sendJson(res, 422, { error: result.reason });
      return;
    }
    sendJson(res, 200, { observedUrl: result.observedUrl, successUrlPattern: result.successUrlPattern, candidateSignals: result.candidateSignals });
  } catch (error) {
    if (res.destroyed) return;
    if (error instanceof ProfileError) {
      sendJson(res, 404, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: "Authentication discovery failed. No conditions were saved." });
  } finally {
    res.off("close", disconnected);
    releaseDiscovery(profileStore, controller);
  }
}
