import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ProfileStore } from "./store.js";

export type TargetIdentity = {
  profileId: string;
  name: string;
  origin: string;
  loginOrigin?: string;
  environmentKind: string;
  /** sha256 over the profile file and its workflows/checks manifests, exactly as stored on disk. */
  fingerprint: string;
};

/**
 * Binds an operation to the configuration the user actually prepared. Any
 * change to the profile or its workflow/check manifests -- including a
 * workflow saved from discovery -- produces a new fingerprint, so an
 * operation prepared against the old configuration is rejected before it
 * can contact anything. Raw bytes are hashed on purpose: no parsing step can
 * make two different files look identical.
 */
export function targetIdentity(store: ProfileStore, profileId: string): TargetIdentity {
  const profile = store.load(profileId);
  const hash = createHash("sha256");
  for (const suffix of [".json", ".workflows.json", ".checks.json"]) {
    const path = join(store.getDir(), `${profile.id}${suffix}`);
    hash.update(`${suffix}\0`);
    hash.update(existsSync(path) ? readFileSync(path) : "<absent>");
    hash.update("\0");
  }
  const loginOrigin = profile.auth.loginUrl ? new URL(profile.auth.loginUrl).origin : undefined;
  return {
    profileId: profile.id,
    name: profile.name,
    origin: new URL(profile.target.url).origin,
    ...(loginOrigin ? { loginOrigin } : {}),
    environmentKind: profile.target.environmentKind,
    fingerprint: hash.digest("hex"),
  };
}

export const expectedTargetSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), origin: z.string().url() }).strict();
export type ExpectedTarget = z.infer<typeof expectedTargetSchema>;

export class TargetChangedError extends Error {
  constructor(message = "The selected application or its configuration changed after setup was checked. Nothing was sent to any application. Check setup again, confirm the target shown beside Start, then retry.") {
    super(message);
    this.name = "TargetChangedError";
  }
}

/** Throws unless the prepared expectation still matches the stored configuration exactly. */
export function assertExpectedTarget(store: ProfileStore, profileId: string, expected: ExpectedTarget | undefined): TargetIdentity {
  if (!expected) throw new TargetChangedError("No prepared target was supplied. Choose an application and check setup before starting. Nothing was sent.");
  const current = targetIdentity(store, profileId);
  if (current.fingerprint !== expected.fingerprint || current.origin !== expected.origin) throw new TargetChangedError();
  return current;
}
