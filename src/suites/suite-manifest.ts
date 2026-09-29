import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadChecksManifest, type DeclaredApiCheck, type DeclaredSecurityCheck } from "../checks/checks-manifest.js";
import { loadWorkflowManifest, type DeclaredWorkflow } from "../pilot/workflow-manifest.js";
import type { ProjectProfile } from "../profiles/schema.js";
import type { ProfileStore } from "../profiles/store.js";

/**
 * Saved regression suites: a named, approved selection of already-saved
 * workflows (`<id>.workflows.json`) and declared checks (`<id>.checks.json`).
 * A suite never contains discovery drafts and never widens what the profile
 * allows -- it can only select from what is already approved and lower the
 * profile's limits.
 *
 * Each item stores `definitionHash`, a hash of the referenced definition
 * including its assertions. That is the suite's explicit expected-assertion
 * snapshot: if a workflow or check is edited afterwards, the suite is stale
 * and refuses to run until it is re-saved, so an old approval can never be
 * silently applied to a different expectation.
 */
export class SuiteError extends Error {
  constructor(message: string, readonly errors: string[] = [message]) {
    super(message);
    this.name = "SuiteError";
  }
}

export const SUITE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const itemIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).max(100);

export const suiteItemSchema = z.object({
  kind: z.enum(["workflow", "api-check", "security-check"]),
  id: itemIdSchema,
  required: z.boolean(),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SuiteItem = z.infer<typeof suiteItemSchema>;

export const suiteLimitsSchema = z.object({
  maxActions: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxApiRequests: z.number().int().positive().optional(),
}).strict();
export type SuiteLimits = z.infer<typeof suiteLimitsSchema>;

export const suiteTargetSchema = z.object({
  origin: z.string().url(),
  environmentKind: z.string().min(1).max(40),
  authMode: z.string().min(1).max(40),
  runSessionAuth: z.enum(["cookie", "observed-authorization"]),
}).strict();
export type SuiteTarget = z.infer<typeof suiteTargetSchema>;

export const suiteSchema = z.object({
  id: z.string().regex(SUITE_ID_RE),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(""),
  revision: z.number().int().positive(),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
  target: suiteTargetSchema,
  items: z.array(suiteItemSchema).max(100),
  limits: suiteLimitsSchema.default({}),
}).strict();
export type Suite = z.infer<typeof suiteSchema>;

const suitesFileSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  suites: z.array(suiteSchema).max(50),
}).strict();
export type SuitesFile = z.infer<typeof suitesFileSchema>;

/** What a user submits to create or edit a suite; hashes, revision, target and dates are always computed here. */
export const suiteInputSchema = z.object({
  id: z.string().regex(SUITE_ID_RE),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(""),
  items: z.array(z.object({ kind: suiteItemSchema.shape.kind, id: itemIdSchema, required: z.boolean() }).strict()).max(100),
  limits: suiteLimitsSchema.default({}),
}).strict();
export type SuiteInput = z.infer<typeof suiteInputSchema>;

/** Key-sorted JSON, so equal definitions always hash equally regardless of property order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Discovery metadata (`observed`) and prose do not change what is asserted; the executable definition does. */
export function workflowDefinitionHash(w: DeclaredWorkflow): string {
  return sha256(canonicalJson({ id: w.id, kind: w.kind, page: w.page, execution: w.execution, reset: w.reset }));
}
export function checkDefinitionHash(c: DeclaredApiCheck | DeclaredSecurityCheck): string {
  return sha256(canonicalJson(c));
}
export function suiteContentHash(suite: Suite): string {
  return sha256(canonicalJson({ id: suite.id, revision: suite.revision, target: suite.target, items: suite.items, limits: suite.limits }));
}

export function suiteTargetFor(profile: ProjectProfile): SuiteTarget {
  return { origin: new URL(profile.target.url).origin, environmentKind: profile.target.environmentKind, authMode: profile.auth.mode, runSessionAuth: profile.apiChecks.runSessionAuth };
}

type AvailableItem = { kind: SuiteItem["kind"]; id: string; description: string; definitionHash: string; note?: string };

/** Everything a suite may select: saved workflows and declared checks only (never discovery drafts). */
export function availableItems(profilesDir: string, profile: ProjectProfile): AvailableItem[] {
  const workflows = loadWorkflowManifest(profilesDir, profile.id)?.workflows ?? [];
  const checks = loadChecksManifest(profilesDir, profile.id);
  const allowedMutations = profile.apiChecks.allowedMutatingEndpoints;
  return [
    ...workflows.map((w) => ({
      kind: "workflow" as const, id: w.id, description: w.description, definitionHash: workflowDefinitionHash(w),
      ...(!w.execution ? { note: "No executable steps; it will be reported as unsupported." } : w.kind && !profile.workflows.allowedWorkflowKinds.includes(w.kind) ? { note: `Kind "${w.kind}" is not allowed by the profile; it will not run.` } : {}),
    })),
    ...(checks?.apiChecks ?? []).map((c) => ({
      kind: "api-check" as const, id: c.id, description: c.description, definitionHash: checkDefinitionHash(c),
      ...(c.method !== "GET" && !allowedMutations.some((m) => m.method === c.method && m.pathname === c.pathname) ? { note: `${c.method} is not authorized by the profile; it will be reported as unsupported and never sent.` } : {}),
    })),
    ...(checks?.securityChecks ?? []).map((c) => ({ kind: "security-check" as const, id: c.id, description: c.description, definitionHash: checkDefinitionHash(c) })),
  ];
}

const suitesPath = (profilesDir: string, profileId: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(profileId)) throw new SuiteError("Invalid profile ID");
  return join(profilesDir, `${profileId}.suites.json`);
};

export function loadSuites(profilesDir: string, profileId: string): SuitesFile {
  const path = suitesPath(profilesDir, profileId);
  if (!existsSync(path)) return { schemaVersion: 1, profileId, suites: [] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf-8")); } catch { throw new SuiteError(`${profileId}.suites.json is not valid JSON`); }
  const parsed = suitesFileSchema.safeParse(raw);
  if (!parsed.success) throw new SuiteError(`${profileId}.suites.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  if (parsed.data.profileId !== profileId) throw new SuiteError(`${profileId}.suites.json belongs to profile "${parsed.data.profileId}"`);
  return parsed.data;
}

export function findSuite(profilesDir: string, profileId: string, suiteId: string): Suite {
  if (!SUITE_ID_RE.test(suiteId)) throw new SuiteError("Invalid suite ID");
  const suite = loadSuites(profilesDir, profileId).suites.find((s) => s.id === suiteId);
  if (!suite) throw new SuiteError(`No suite "${suiteId}" exists for this application.`);
  return suite;
}

/**
 * Everything that must hold before a suite may contact an application.
 * Returned as a list so the UI and CLI can show every problem at once.
 */
export function validateSuite(store: ProfileStore, profileId: string, suite: Suite): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let profile: ProjectProfile;
  try { profile = store.load(profileId); } catch { return { ok: false, errors: [`Application profile "${profileId}" could not be loaded.`] }; }
  const target = suiteTargetFor(profile);
  if (target.origin !== suite.target.origin) errors.push(`The suite was approved for ${suite.target.origin}, but the application now points to ${target.origin}.`);
  if (target.environmentKind !== suite.target.environmentKind) errors.push(`Environment changed from ${suite.target.environmentKind} to ${target.environmentKind}.`);
  if (target.authMode !== suite.target.authMode) errors.push(`Authentication mode changed from ${suite.target.authMode} to ${target.authMode}.`);
  if (target.runSessionAuth !== suite.target.runSessionAuth) errors.push(`API session mode changed from ${suite.target.runSessionAuth} to ${target.runSessionAuth}.`);
  const available = new Map(availableItems(store.getDir(), profile).map((i) => [`${i.kind}:${i.id}`, i]));
  const seen = new Set<string>();
  for (const item of suite.items) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) errors.push(`${item.id} is listed twice.`);
    seen.add(key);
    const current = available.get(key);
    if (!current) errors.push(`${item.kind === "workflow" ? "Workflow" : "Check"} ${item.id} no longer exists (removed or renamed). Edit the suite.`);
    else if (current.definitionHash !== item.definitionHash) errors.push(`${item.id} changed since suite revision ${suite.revision} was approved. Review it and save the suite again.`);
  }
  if (!suite.items.length) errors.push("The suite has no items.");
  else if (!suite.items.some((i) => i.required)) errors.push("At least one item must be required; a suite of only optional items cannot pass or fail.");
  for (const key of ["maxActions", "maxDurationMs", "maxApiRequests"] as const) {
    const value = suite.limits[key];
    const cap = key === "maxApiRequests" ? profile.limits.maxApiRequests ?? profile.limits.maxActions : profile.limits[key];
    if (value !== undefined && value > cap) errors.push(`Suite ${key} (${value}) exceeds the profile limit (${cap}); suites can only lower limits.`);
  }
  const checkKinds = suite.items.filter((i) => i.kind !== "workflow");
  if (checkKinds.some((i) => i.kind === "api-check") && !profile.apiChecks.enabled) errors.push("API checks are disabled in this profile.");
  if (checkKinds.some((i) => i.kind === "security-check") && !profile.securityChecks.enabled) errors.push("Security checks are disabled in this profile.");
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Creates or edits a suite from user input. Hashes come from the current saved definitions, never from the client. */
export function saveSuite(store: ProfileStore, profileId: string, input: SuiteInput, now = new Date()): Suite {
  const parsed = suiteInputSchema.parse(input);
  const profile = store.load(profileId);
  const available = new Map(availableItems(store.getDir(), profile).map((i) => [`${i.kind}:${i.id}`, i]));
  const missing = parsed.items.filter((i) => !available.has(`${i.kind}:${i.id}`));
  if (missing.length) throw new SuiteError("Unknown items", missing.map((i) => `${i.id} is not a saved workflow or declared check of this application (discovery drafts must be saved first).`));
  const file = loadSuites(store.getDir(), profileId);
  const existing = file.suites.find((s) => s.id === parsed.id);
  const suite: Suite = {
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    revision: existing ? existing.revision + 1 : 1,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    target: suiteTargetFor(profile),
    items: parsed.items.map((i) => ({ ...i, definitionHash: available.get(`${i.kind}:${i.id}`)!.definitionHash })),
    limits: parsed.limits,
  };
  const validation = validateSuite(store, profileId, suite);
  if (!validation.ok) throw new SuiteError("Suite is not valid", validation.errors);
  const next: SuitesFile = { schemaVersion: 1, profileId, suites: [...file.suites.filter((s) => s.id !== suite.id), suite] };
  const path = suitesPath(store.getDir(), profileId);
  mkdirSync(store.getDir(), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(suitesFileSchema.parse(next), null, 2), "utf-8");
  renameSync(`${path}.tmp`, path);
  return suite;
}
