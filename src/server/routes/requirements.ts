import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ProfileError } from "../../profiles/schema.js";
import type { ProfileStore } from "../../profiles/store.js";
import { approveRequirement, assertionCatalog, exportRequirements, importRequirements, loadRequirements, RequirementError, requirementInputSchema, saveRequirement, suggestRequirements } from "../../requirements-coverage/requirements.js";
import { readJsonBody, sendJson } from "../http-helpers.js";

/**
 * Local requirement editing. Nothing here contacts an application or a model.
 * Saving always produces a draft revision; only the explicit approve action
 * makes a requirement count in coverage.
 */
const PROFILE_ID_RE = /^[A-Za-z0-9_-]+$/;
const REQ_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof RequirementError) { sendJson(res, 400, { error: error.message, errors: error.errors }); return; }
  if (error instanceof ProfileError) { sendJson(res, 404, { error: error.message }); return; }
  throw error;
}

export function handleListRequirements(res: ServerResponse, store: ProfileStore, profileId: string): void {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  try {
    const profile = store.load(profileId);
    sendJson(res, 200, { requirements: loadRequirements(store.getDir(), profileId).requirements, catalog: assertionCatalog(store.getDir(), profile) });
  } catch (error) { fail(res, error); }
}

export function handleRequirementSuggestions(res: ServerResponse, store: ProfileStore, profileId: string): void {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  try { sendJson(res, 200, { suggestions: suggestRequirements(store.getDir(), store.load(profileId)), note: "Suggestions restate approved assertions. They are not saved or approved until you review them." }); }
  catch (error) { fail(res, error); }
}

export function handleExportRequirements(res: ServerResponse, store: ProfileStore, profileId: string): void {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  try {
    store.load(profileId);
    const body = JSON.stringify(exportRequirements(store.getDir(), profileId), null, 2);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${profileId}.requirements.export.json"`, "X-Content-Type-Options": "nosniff" });
    res.end(body);
  } catch (error) { fail(res, error); }
}

const saveSchema = z.object({ requirement: requirementInputSchema }).strict();
const approveSchema = z.object({ revision: z.number().int().positive() }).strict();

export async function handleSaveRequirement(req: IncomingMessage, res: ServerResponse, store: ProfileStore, profileId: string): Promise<void> {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  let raw: unknown;
  try { raw = await readJsonBody(req); } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" }); return; }
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) { sendJson(res, 400, { error: "Invalid requirement.", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }); return; }
  try { sendJson(res, 200, { requirement: saveRequirement(store, profileId, parsed.data.requirement) }); } catch (error) { fail(res, error); }
}

export async function handleApproveRequirement(req: IncomingMessage, res: ServerResponse, store: ProfileStore, profileId: string, requirementId: string): Promise<void> {
  if (!PROFILE_ID_RE.test(profileId) || !REQ_ID_RE.test(requirementId)) { sendJson(res, 400, { error: "Invalid ID" }); return; }
  let raw: unknown;
  try { raw = await readJsonBody(req); } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" }); return; }
  const parsed = approveSchema.safeParse(raw);
  if (!parsed.success) { sendJson(res, 400, { error: "Invalid approval." }); return; }
  try { sendJson(res, 200, { requirement: approveRequirement(store, profileId, requirementId, parsed.data.revision) }); } catch (error) { fail(res, error); }
}

export async function handleImportRequirements(req: IncomingMessage, res: ServerResponse, store: ProfileStore, profileId: string): Promise<void> {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  let raw: unknown;
  try { raw = await readJsonBody(req); } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" }); return; }
  try { sendJson(res, 200, { imported: importRequirements(store, profileId, raw).map((r) => ({ id: r.id, revision: r.revision, status: r.status })) }); } catch (error) { fail(res, error); }
}
