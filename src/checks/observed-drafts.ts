import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ApiObservations, ObservedEndpoint } from "../auth/api-observer.js";
import { PARAM_VALUE_RE, SECRET_PARAM_RE } from "../contracts/openapi.js";
import type { DeclaredApiCheck } from "./checks-manifest.js";

/**
 * Turns a run's passive API observation (api-observations.json) into
 * reviewable check drafts. Nothing here contacts an application, and an
 * observation never authorizes anything by itself: a draft becomes a check
 * only when a person approves it, and approval re-derives the draft on the
 * server from the stored observation.
 *
 * A draft keeps four things apart:
 * - observedFacts: what the samples showed (statuses, media types, names and types);
 * - proposedAssertions: expectations AutoQA may suggest from those facts;
 * - the user's selection: the subset actually approved;
 * - officialContract: always null here (an imported OpenAPI contract is a separate path).
 * Observed samples never imply that a field is required, that a set of
 * values is an enumeration, or that a GET is free of side effects (RFC 9110 §9.2.1).
 */
export class ObservedDraftError extends Error {
  constructor(message: string, readonly code: "not-found" | "stale" | "cross-profile" | "invalid") {
    super(message);
    this.name = "ObservedDraftError";
  }
}

export const observedSelectionSchema = z.object({
  origin: z.string().url(),
  method: z.literal("GET"),
  pathTemplate: z.string().startsWith("/").max(200),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
  /** Explicit, non-secret test value for every observed query parameter name. */
  query: z.record(z.string().max(100), z.string().max(100)).default({}),
  assertions: z.object({
    status: z.boolean().default(false),
    contentType: z.boolean().default(false),
    /** Field paths (e.g. "items", "total") whose observed type becomes an assertion. */
    shape: z.array(z.string().max(200)).max(30).default([]),
    /** Opt-in only: presence was seen in every sample, which does not show the API requires it. */
    required: z.array(z.string().max(200)).max(30).default([]),
  }).strict(),
}).strict();
export type ObservedSelection = z.infer<typeof observedSelectionSchema>;

type ShapeAssertionType = "string" | "number" | "boolean" | "array" | "object";
export type ProposedAssertion = { id: string; kind: "status" | "content-type" | "shape" | "required"; expected: string; provenance: string };

export type ObservedDraft = {
  profileId: string;
  origin: string;
  method: "GET";
  pathTemplate: string;
  source: { runId: string; observationRef: "api-observations.json"; observationSha256: string };
  observedFacts: { statuses: number[]; contentTypes: string[]; queryNames: string[]; samplesWithBody: number; observations: number; seenOnPages: string[]; omissions: ObservedEndpoint["omissions"]; emptyArrays: string[] };
  proposedAssertions: ProposedAssertion[];
  authMode: "run-session";
  requestLimits: { requests: "one per run, plus one confirmation on a failed assertion"; responseBytes: "profile apiChecks.responseSizeCapBytes, enforced on decoded bytes" };
  evidence: "structure-only";
  completeness: string;
  limitations: string[];
  officialContract: null;
  executable: boolean;
  problems: string[];
  check?: DeclaredApiCheck;
};

export type StoredObservation = { observations: ApiObservations & { runId?: string; profileId?: string | null }; sha256: string };

const RUN_ID_RE = /^RUN-[A-Za-z0-9-]{1,80}$/;

/** Reads a run's observation with the digest of its exact bytes (the stale/tamper reference). */
export function readObservation(runsRoot: string, runId: string): StoredObservation {
  if (!RUN_ID_RE.test(runId)) throw new ObservedDraftError("Invalid run ID.", "invalid");
  const path = join(runsRoot, runId, "api-observations.json");
  if (!existsSync(path)) throw new ObservedDraftError("That run has no API observation. Observation is recorded only by signed-in runs that reach their workflows.", "not-found");
  const raw = readFileSync(path);
  let observations: StoredObservation["observations"];
  try { observations = JSON.parse(raw.toString("utf-8")) as StoredObservation["observations"]; } catch { throw new ObservedDraftError("The observation file is not valid JSON.", "invalid"); }
  if (observations.schemaVersion !== 2 || !Array.isArray(observations.endpoints)) throw new ObservedDraftError("The observation was recorded by an older version and cannot be used for drafts. Run the suite again.", "invalid");
  return { observations, sha256: createHash("sha256").update(raw).digest("hex") };
}

const fieldPath = (shapePath: string): string | undefined => {
  // Only plain object paths below the root: no array elements, no masked names.
  if (!shapePath.startsWith("$.") || shapePath.includes("[*]") || shapePath.includes("<")) return undefined;
  return shapePath.slice(2);
};

const shapeType = (types: string[]): ShapeAssertionType | undefined => {
  if (types.length === 1 && ["string", "boolean", "array", "object"].includes(types[0]!)) return types[0] as ShapeAssertionType;
  if (types.length >= 1 && types.every((t) => t === "integer" || t === "number")) return "number";
  return undefined;
};

const slug = (path: string): string => `OBS-${path.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}`.slice(0, 80);

/** Every expectation AutoQA may propose for one endpoint, each with its provenance in the samples. */
export function proposeAssertions(endpoint: ObservedEndpoint): ProposedAssertion[] {
  const proposals: ProposedAssertion[] = [];
  const success = endpoint.statuses.filter((s) => s >= 200 && s < 300);
  if (endpoint.statuses.length === 1 && success.length === 1) proposals.push({ id: "status", kind: "status", expected: String(success[0]), provenance: `observed in ${endpoint.observations}/${endpoint.observations} responses` });
  const media = endpoint.contentTypes.filter((c) => c && c !== "other" && !c.includes("*"));
  if (endpoint.contentTypes.length === 1 && media.length === 1) proposals.push({ id: "content-type", kind: "content-type", expected: media[0]!, provenance: `observed in ${endpoint.observations}/${endpoint.observations} responses` });
  if (endpoint.samplesWithBody > 0) {
    for (const [path, entry] of Object.entries(endpoint.shape)) {
      const field = fieldPath(path);
      const type = shapeType(entry.types);
      if (!field || !type || entry.seenIn !== endpoint.samplesWithBody) continue;
      const provenance = `type ${type} in ${entry.seenIn}/${endpoint.samplesWithBody} body samples`;
      proposals.push({ id: `shape:${field}`, kind: "shape", expected: type, provenance });
      proposals.push({ id: `field:${field}`, kind: "required", expected: "present (opt-in: presence in samples does not show the API requires it)", provenance });
    }
  }
  return proposals;
}

/**
 * Builds drafts for explicit selections. `targetOrigin` is the application's
 * own origin (checks are only ever sent there); `inScope` applies the
 * profile's path prefixes.
 */
export function buildObservedDrafts(stored: StoredObservation, profileId: string, targetOrigin: string, selections: ObservedSelection[], inScope: (pathname: string) => boolean): ObservedDraft[] {
  const { observations, sha256 } = stored;
  if (observations.profileId !== profileId) throw new ObservedDraftError("That observation was recorded for a different application.", "cross-profile");
  if (!observations.runId || !RUN_ID_RE.test(observations.runId)) throw new ObservedDraftError("The observation does not name its run.", "invalid");
  if (selections.length > 20) throw new ObservedDraftError("Select at most 20 endpoints at a time.", "invalid");
  return selections.map((selection): ObservedDraft => {
    const endpoint = observations.endpoints.find((e) => e.origin === selection.origin && e.method === selection.method && e.pathTemplate === selection.pathTemplate);
    if (!endpoint) throw new ObservedDraftError(`${selection.method} ${selection.pathTemplate} on ${selection.origin} was not observed in that run.`, "not-found");
    const problems: string[] = [];
    if (endpoint.origin !== targetOrigin) problems.push(`Observed on ${endpoint.origin}; checks are sent only to the application's own origin (${targetOrigin}).`);
    if (endpoint.ambiguous) problems.push("Part of the path was masked during observation, so the real path is unknown and could merge different targets.");
    else if (/\{[^}]*\}/.test(endpoint.pathTemplate)) problems.push("The path has a parameter whose value was never recorded; this draft cannot name a concrete path.");
    if (!inScope(endpoint.pathTemplate)) problems.push("The path is outside the application's allowed path prefixes.");

    const query: Record<string, string> = {};
    for (const name of endpoint.queryNames) {
      if (name.startsWith("<")) { problems.push("A query parameter name was masked during observation; the request cannot be reproduced faithfully."); continue; }
      if (SECRET_PARAM_RE.test(name)) { problems.push(`Query parameter "${name}" looks credential-bearing; observation drafts accept only non-secret test values.`); continue; }
      const value = selection.query[name];
      if (value === undefined || value === "") { problems.push(`Provide an explicit, non-secret test value for query parameter "${name}" (the application sent it; its value was never recorded).`); continue; }
      if (!PARAM_VALUE_RE.test(value)) { problems.push(`The value for "${name}" must be 1–100 characters of letters, digits, ".", "_", "~" or "-".`); continue; }
      query[name] = value;
    }
    for (const name of Object.keys(selection.query)) if (!endpoint.queryNames.includes(name)) problems.push(`Query parameter "${name}" was not observed for this endpoint.`);

    const proposals = proposeAssertions(endpoint);
    const has = (id: string) => proposals.find((p) => p.id === id);
    const assertions: DeclaredApiCheck["assertions"] = { invariants: [] };
    if (selection.assertions.status) { const p = has("status"); if (p) assertions.expectedStatus = Number(p.expected); else problems.push("No single successful status was observed, so a status expectation cannot be proposed."); }
    if (selection.assertions.contentType) { const p = has("content-type"); if (p) assertions.expectedContentType = p.expected; else problems.push("No single specific content type was observed."); }
    const shape: Record<string, ShapeAssertionType> = {};
    for (const field of selection.assertions.shape) {
      const p = has(`shape:${field}`);
      if (!p) { problems.push(`"${field}" is not an observed fact usable as a type assertion (masked, inside an array, mixed types, or not in every sample).`); continue; }
      shape[field] = p.expected as ShapeAssertionType;
    }
    if (Object.keys(shape).length) assertions.shape = shape;
    const required: string[] = [];
    for (const field of selection.assertions.required) {
      if (!has(`field:${field}`)) { problems.push(`"${field}" cannot be required: it was not seen in every body sample.`); continue; }
      required.push(field);
    }
    if (required.length) assertions.requiredFields = required;
    const selectedCount = (assertions.expectedStatus !== undefined ? 1 : 0) + (assertions.expectedContentType ? 1 : 0) + Object.keys(shape).length + required.length;
    if (selectedCount === 0) problems.push("Select at least one assertion; a check with no expectation verifies nothing.");

    const executable = problems.length === 0;
    const completeness = endpoint.samplesWithBody === 0
      ? `Metadata only: ${endpoint.observations} response(s) observed, no body sample (${endpoint.omissions.map((o) => o.reason).join(", ") || "no body captured"}). No structure is known.`
      : `${endpoint.samplesWithBody} body sample(s) from ${endpoint.observations} response(s); sampled, not a complete schema.`;
    return {
      profileId,
      origin: endpoint.origin,
      method: "GET",
      pathTemplate: endpoint.pathTemplate,
      source: { runId: observations.runId!, observationRef: "api-observations.json", observationSha256: sha256 },
      observedFacts: { statuses: endpoint.statuses, contentTypes: endpoint.contentTypes, queryNames: endpoint.queryNames, samplesWithBody: endpoint.samplesWithBody, observations: endpoint.observations, seenOnPages: endpoint.seenOnPages, omissions: endpoint.omissions, emptyArrays: endpoint.emptyArrays },
      proposedAssertions: proposals,
      authMode: "run-session",
      requestLimits: { requests: "one per run, plus one confirmation on a failed assertion", responseBytes: "profile apiChecks.responseSizeCapBytes, enforced on decoded bytes" },
      evidence: "structure-only",
      completeness,
      limitations: [
        "Observed traffic does not authorize replay; the check runs only after explicit approval.",
        "A GET observed from the application is not thereby shown to be free of side effects.",
        "Fields seen in every sample are not shown to be required; observed values define no enumeration.",
        ...(endpoint.emptyArrays.length ? [`Arrays seen only empty (${endpoint.emptyArrays.join(", ")}) say nothing about their elements.`] : []),
      ],
      officialContract: null,
      executable,
      problems,
      ...(executable ? {
        check: {
          id: selection.id ?? slug(endpoint.pathTemplate),
          method: "GET" as const,
          pathname: endpoint.pathTemplate,
          description: `Observed GET ${endpoint.pathTemplate}: approved expectations from run ${observations.runId}`,
          ...(Object.keys(query).length ? { query } : {}),
          evidence: "structure-only" as const,
          provenance: { kind: "observed" as const, runId: observations.runId!, observationSha256: sha256, pathTemplate: endpoint.pathTemplate },
          assertions,
        },
      } : {}),
    };
  });
}
