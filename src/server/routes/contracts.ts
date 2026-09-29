import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { saveApiChecks } from "../../checks/checks-manifest.js";
import { scopedCheckUrl } from "../../checks/request-scope.js";
import { buildContractDrafts, ContractError, contractSelectionSchema, parseContract } from "../../contracts/openapi.js";
import { assertExpectedTarget, expectedTargetSchema, TargetChangedError } from "../../profiles/fingerprint.js";
import { ProfileError } from "../../profiles/schema.js";
import type { ProfileStore } from "../../profiles/store.js";
import { readJsonBody, sendJson } from "../http-helpers.js";

/**
 * Local OpenAPI contract import. Nothing here contacts an application:
 * parse and draft are pure; approve re-derives the drafts from the same
 * document and selections on the server (client-edited drafts are never
 * trusted) and saves only executable GET checks. The contract's `servers`
 * never widen scope: drafts are bound to the profile's own origin and
 * path prefixes.
 */
const PROFILE_ID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_REQUEST_BYTES = 2_500_000;
const documentField = z.string().min(2).max(2_200_000);
const sourceField = z.string().regex(/^[A-Za-z0-9._ -]{1,120}$/).default("contract.json");
const parseSchema = z.object({ document: documentField }).strict();
const draftSchema = z.object({ document: documentField, source: sourceField, selections: z.array(contractSelectionSchema).min(1).max(50) }).strict();
const approveSchema = draftSchema.extend({ expected: expectedTargetSchema }).strict();

async function body<S extends z.ZodTypeAny>(req: IncomingMessage, res: ServerResponse, schema: S): Promise<z.infer<S> | undefined> {
  let raw: unknown;
  try { raw = await readJsonBody(req, MAX_REQUEST_BYTES); } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" }); return undefined; }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) { sendJson(res, 400, { error: "Invalid contract request.", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }); return undefined; }
  return parsed.data;
}

function drafts(profileStore: ProfileStore, profileId: string, document: string, source: string, selections: z.infer<typeof contractSelectionSchema>[]) {
  const profile = profileStore.load(profileId);
  const origin = new URL(profile.target.url).origin;
  const contract = parseContract(document);
  return { contract, drafts: buildContractDrafts(contract, source, selections, (pathname) => Boolean(scopedCheckUrl(profile, origin, pathname))) };
}

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof ContractError) { sendJson(res, 422, { error: error.message, code: error.code }); return; }
  if (error instanceof TargetChangedError) { sendJson(res, 409, { error: error.message, code: "TARGET_CHANGED" }); return; }
  if (error instanceof ProfileError) { sendJson(res, 404, { error: error.message }); return; }
  throw error;
}

export async function handleContractParse(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore, profileId: string): Promise<void> {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  const data = await body(req, res, parseSchema);
  if (!data) return;
  try {
    profileStore.load(profileId);
    const c = parseContract(data.document);
    sendJson(res, 200, { title: c.title, version: c.version, openapi: c.openapi, sha256: c.sha256, notes: c.notes, operations: c.operations });
  } catch (error) { fail(res, error); }
}

export async function handleContractDrafts(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore, profileId: string): Promise<void> {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  const data = await body(req, res, draftSchema);
  if (!data) return;
  try {
    sendJson(res, 200, { drafts: drafts(profileStore, profileId, data.document, data.source ?? "contract.json", data.selections).drafts });
  } catch (error) { fail(res, error); }
}

export async function handleContractApprove(req: IncomingMessage, res: ServerResponse, profileStore: ProfileStore, profileId: string, runBusy: () => boolean): Promise<void> {
  if (!PROFILE_ID_RE.test(profileId)) { sendJson(res, 400, { error: "Invalid profile ID" }); return; }
  const data = await body(req, res, approveSchema);
  if (!data) return;
  if (runBusy()) { sendJson(res, 409, { error: "Finish or stop the current run before changing approved checks." }); return; }
  try {
    assertExpectedTarget(profileStore, profileId, data.expected);
    const result = drafts(profileStore, profileId, data.document, data.source ?? "contract.json", data.selections);
    const blocked = result.drafts.filter((d) => !d.executable || !d.check);
    if (blocked.length) { sendJson(res, 422, { error: "Some selected operations cannot be approved; nothing was saved.", drafts: result.drafts }); return; }
    saveApiChecks(profileStore.getDir(), profileId, result.drafts.map((d) => d.check!));
    sendJson(res, 200, { saved: result.drafts.map((d) => d.check!.id) });
  } catch (error) { fail(res, error); }
}
