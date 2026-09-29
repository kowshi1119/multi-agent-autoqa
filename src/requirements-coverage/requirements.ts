import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadChecksManifest } from "../checks/checks-manifest.js";
import { SECURITY_HEADERS } from "../checks/security-assertions.js";
import { evaluateContract } from "../contracts/openapi.js";
import { loadWorkflowManifest } from "../pilot/workflow-manifest.js";
import type { ProjectProfile } from "../profiles/schema.js";
import type { ProfileStore } from "../profiles/store.js";
import { checkDefinitionHash, workflowDefinitionHash } from "../suites/suite-manifest.js";

/**
 * User-approved requirements with explicit acceptance criteria, traced to
 * approved workflow/check assertions. Kept in `profiles/<id>.requirements.json`.
 *
 * This is deliberately separate from src/requirements.ts (`RequirementRule`),
 * which is per-pathname context given to the Critic model. Approved
 * requirements are never sent to any model and are never inferred: AutoQA
 * may *suggest* drafts that restate existing approved assertions, but a
 * requirement only counts once a person approves it, and editing an
 * approved requirement makes it a new draft revision that must be approved
 * again. No business rule, calculation, permission or expected value is
 * invented here.
 */
export class RequirementError extends Error {
  constructor(message: string, readonly errors: string[] = [message]) {
    super(message);
    this.name = "RequirementError";
  }
}

const idRe = /^[A-Za-z0-9_-]{1,64}$/;
export const linkSchema = z.object({
  kind: z.enum(["workflow", "api-check", "security-check"]),
  itemId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(100),
  /** A stable assertion id reported by that item, or "*" for every assertion the item reports. */
  assertionId: z.string().min(1).max(200),
  /** The item's definition hash when the requirement was approved; a later change makes results incomparable. */
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type CriterionLink = z.infer<typeof linkSchema>;

export const criterionSchema = z.object({
  id: z.string().regex(idRe),
  description: z.string().min(1).max(500),
  required: z.boolean(),
  links: z.array(linkSchema).max(20).default([]),
}).strict();

export const requirementSchema = z.object({
  id: z.string().regex(idRe),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  importance: z.enum(["critical", "high", "medium", "low"]),
  revision: z.number().int().positive(),
  status: z.enum(["draft", "approved"]),
  origin: z.enum(["user", "suggested", "imported"]).default("user"),
  criteria: z.array(criterionSchema).min(1).max(50),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
  approvedAt: z.string().max(40).optional(),
}).strict();
export type Requirement = z.infer<typeof requirementSchema>;

const fileSchema = z.object({ schemaVersion: z.literal(1), profileId: z.string().regex(/^[A-Za-z0-9_-]+$/), requirements: z.array(requirementSchema).max(200) }).strict();
export type RequirementsFile = z.infer<typeof fileSchema>;

/** What a person edits: no revision, status, dates or hashes (always set by the server). */
export const requirementInputSchema = z.object({
  id: z.string().regex(idRe),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  importance: z.enum(["critical", "high", "medium", "low"]),
  criteria: z.array(z.object({ id: z.string().regex(idRe), description: z.string().min(1).max(500), required: z.boolean(), links: z.array(linkSchema.omit({ definitionHash: true })).max(20).default([]) }).strict()).min(1).max(50),
}).strict();
export type RequirementInput = z.infer<typeof requirementInputSchema>;

// --- Assertion catalogue -------------------------------------------------------------------------------

export type CatalogItem = { kind: CriterionLink["kind"]; itemId: string; description: string; definitionHash: string; assertionIds: string[]; dynamic?: string };

/** Every assertion id each approved item can report, derived from its definition only. */
export function assertionCatalog(profilesDir: string, profile: ProjectProfile): CatalogItem[] {
  const workflows = loadWorkflowManifest(profilesDir, profile.id)?.workflows ?? [];
  const checks = loadChecksManifest(profilesDir, profile.id);
  return [
    ...workflows.map((w): CatalogItem => {
      const c = w.execution?.completion;
      const ids = c ? ["url", "visible", ...Object.keys(c.query ?? {}).map((k) => `query:${k}`), ...(c.absent ?? []).map((_, i) => `absent:${i}`), ...(c.inputValue ? ["inputValue"] : []), ...(c.count ? ["count"] : []), ...(c.changedFrom ? ["changedFrom"] : [])] : [];
      return { kind: "workflow", itemId: w.id, description: w.description, definitionHash: workflowDefinitionHash(w), assertionIds: ids };
    }),
    ...(checks?.apiChecks ?? []).map((c): CatalogItem => {
      const a = c.assertions;
      const declared = [...(a.expectedStatus !== undefined ? ["status"] : []), ...(a.expectedContentType !== undefined ? ["content-type"] : []), ...(a.requiredFields ?? []).map((f) => `field:${f}`), ...Object.keys(a.shape ?? {}).map((f) => `shape:${f}`), ...a.invariants.map((_, i) => `invariant:${i}`)];
      // Contract ids depend on the schema only, so evaluating an empty body yields the complete id set.
      const contract = c.contract ? evaluateContract(c.contract, { status: 0, contentType: c.contract.contentType ?? undefined, body: {} }).map((r) => r.id) : [];
      return { kind: "api-check", itemId: c.id, description: c.description, definitionHash: checkDefinitionHash(c), assertionIds: [...declared, ...contract] };
    }),
    ...(checks?.securityChecks ?? []).map((c): CatalogItem => ({
      kind: "security-check", itemId: c.id, description: c.description, definitionHash: checkDefinitionHash(c),
      assertionIds: c.kind === "security-headers" ? SECURITY_HEADERS.map((h) => `header:${h}`) : c.kind === "secret-leakage" ? ["secret:sensitive-field", "secret:key-shaped-value"] : c.kind === "session-boundary" ? ["cross-account:denied"] : [],
      ...(c.kind === "cookie-attributes" ? { dynamic: "Cookie assertions are named after the cookies observed at run time; link with \"*\"." } : {}),
    })),
  ];
}

// --- Storage -------------------------------------------------------------------------------------------------

const pathFor = (profilesDir: string, profileId: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(profileId)) throw new RequirementError("Invalid profile ID");
  return join(profilesDir, `${profileId}.requirements.json`);
};

export function loadRequirements(profilesDir: string, profileId: string): RequirementsFile {
  const path = pathFor(profilesDir, profileId);
  if (!existsSync(path)) return { schemaVersion: 1, profileId, requirements: [] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf-8")); } catch { throw new RequirementError(`${profileId}.requirements.json is not valid JSON`); }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success || parsed.data.profileId !== profileId) throw new RequirementError(`${profileId}.requirements.json is invalid or belongs to another application`);
  return parsed.data;
}

function write(profilesDir: string, file: RequirementsFile): void {
  const path = pathFor(profilesDir, file.profileId);
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(fileSchema.parse(file), null, 2), "utf-8");
  renameSync(`${path}.tmp`, path);
}

function validateLinks(catalog: CatalogItem[], criteria: RequirementInput["criteria"]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const c of criteria) {
    if (ids.has(c.id)) errors.push(`Criterion ${c.id} is listed twice.`);
    ids.add(c.id);
    for (const link of c.links) {
      const item = catalog.find((i) => i.kind === link.kind && i.itemId === link.itemId);
      if (!item) { errors.push(`Criterion ${c.id}: ${link.kind} ${link.itemId} is not an approved workflow or check.`); continue; }
      if (link.assertionId !== "*" && !item.assertionIds.includes(link.assertionId)) errors.push(`Criterion ${c.id}: ${link.itemId} does not report assertion "${link.assertionId}"${item.dynamic ? ` (${item.dynamic})` : ""}.`);
    }
  }
  return errors;
}

/** Create or edit. Editing always produces a new *draft* revision; approval is a separate, explicit action. */
export function saveRequirement(store: ProfileStore, profileId: string, input: RequirementInput, origin: Requirement["origin"] = "user", now = new Date()): Requirement {
  const parsed = requirementInputSchema.parse(input);
  const profile = store.load(profileId);
  const errors = validateLinks(assertionCatalog(store.getDir(), profile), parsed.criteria);
  if (errors.length) throw new RequirementError("Requirement is not valid", errors);
  const file = loadRequirements(store.getDir(), profileId);
  const existing = file.requirements.find((r) => r.id === parsed.id);
  const requirement: Requirement = {
    ...parsed,
    criteria: parsed.criteria.map((c) => ({ ...c, links: c.links.map((l) => ({ ...l })) })),
    revision: existing ? existing.revision + 1 : 1,
    status: "draft",
    origin: existing?.origin === "user" ? "user" : origin,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
  write(store.getDir(), { ...file, requirements: [...file.requirements.filter((r) => r.id !== requirement.id), requirement] });
  return requirement;
}

/** Explicit approval: re-validates links and records each linked item's current definition hash. */
export function approveRequirement(store: ProfileStore, profileId: string, requirementId: string, revision: number, now = new Date()): Requirement {
  const profile = store.load(profileId);
  const file = loadRequirements(store.getDir(), profileId);
  const requirement = file.requirements.find((r) => r.id === requirementId);
  if (!requirement) throw new RequirementError(`No requirement "${requirementId}".`);
  if (requirement.revision !== revision) throw new RequirementError(`Requirement ${requirementId} is now at revision ${requirement.revision}; review that revision before approving.`);
  if (requirement.status === "approved") throw new RequirementError(`Revision ${revision} is already approved.`);
  const catalog = assertionCatalog(store.getDir(), profile);
  const errors = validateLinks(catalog, requirement.criteria);
  if (errors.length) throw new RequirementError("Requirement links are no longer valid", errors);
  const approved: Requirement = {
    ...requirement,
    status: "approved",
    approvedAt: now.toISOString(),
    criteria: requirement.criteria.map((c) => ({ ...c, links: c.links.map((l) => ({ ...l, definitionHash: catalog.find((i) => i.kind === l.kind && i.itemId === l.itemId)!.definitionHash })) })),
  };
  write(store.getDir(), { ...file, requirements: file.requirements.map((r) => r.id === requirementId ? approved : r) });
  return approved;
}

/**
 * Unapproved suggestions that restate approved assertions; the criterion text
 * is the assertion's own definition, nothing more. The user must review,
 * edit and approve before anything counts.
 */
export function suggestRequirements(profilesDir: string, profile: ProjectProfile): RequirementInput[] {
  return assertionCatalog(profilesDir, profile).filter((i) => i.assertionIds.length || i.dynamic).map((item) => ({
    id: `SUGGESTED-${item.itemId}`.slice(0, 64),
    title: item.description.slice(0, 200),
    description: `Suggested from the approved ${item.kind} ${item.itemId}. Review: the wording restates existing assertions and adds no business rule.`,
    importance: "medium" as const,
    criteria: [{ id: "C1", description: `Every assertion reported by ${item.kind} ${item.itemId} passes.`, required: true, links: [{ kind: item.kind, itemId: item.itemId, assertionId: "*" }] }],
  }));
}

/** Import validated JSON; every imported requirement becomes a draft that must be approved locally. */
export function importRequirements(store: ProfileStore, profileId: string, raw: unknown): Requirement[] {
  // Accepts this module's own export shape (revision, status, hashes, dates are ignored); every field used is re-validated strictly below.
  const row = z.object({
    id: z.string(), title: z.string(), description: z.string().optional(), importance: z.string(),
    criteria: z.array(z.object({ id: z.string(), description: z.string(), required: z.boolean(), links: z.array(z.object({ kind: z.string(), itemId: z.string(), assertionId: z.string() }).passthrough()).default([]) }).passthrough()),
  }).passthrough();
  const parsed = z.object({ requirements: z.array(row).min(1).max(200) }).passthrough().safeParse(raw);
  if (!parsed.success) throw new RequirementError("The file is not a valid requirements export", parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`));
  const inputs = parsed.data.requirements.map((r) => requirementInputSchema.safeParse({ id: r.id, title: r.title, description: r.description, importance: r.importance, criteria: r.criteria.map((c) => ({ id: c.id, description: c.description, required: c.required, links: c.links.map((l) => ({ kind: l.kind, itemId: l.itemId, assertionId: l.assertionId })) })) }));
  const invalid = inputs.flatMap((r, i) => r.success ? [] : r.error.issues.slice(0, 5).map((issue) => `requirements.${i}.${issue.path.join(".")}: ${issue.message}`));
  if (invalid.length) throw new RequirementError("The file is not a valid requirements export", invalid);
  return inputs.map((r) => saveRequirement(store, profileId, (r as { success: true; data: RequirementInput }).data, "imported"));
}

export function exportRequirements(profilesDir: string, profileId: string): { schemaVersion: 1; profileId: string; exportedAt: string; note: string; requirements: Requirement[] } {
  return { schemaVersion: 1, profileId, exportedAt: new Date().toISOString(), note: "Importing this file creates draft requirements that must be approved again.", requirements: loadRequirements(profilesDir, profileId).requirements };
}
