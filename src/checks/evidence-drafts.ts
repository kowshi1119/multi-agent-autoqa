import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveArtifactPath } from "../server/security.js";
import { checkDefinitionHash } from "../suites/suite-manifest.js";
import type { DeclaredApiCheck } from "./checks-manifest.js";
import type { ChecksLedger, CheckLedgerEntry } from "./types.js";

/**
 * Stage B of the compressed-API workflow. A passive observation of a
 * compressed response cannot be shape-sampled within a safe bound, so its
 * draft offers only status and media type. Once a person has approved such
 * a check and a run has executed it (through the bounded requester, whose
 * decoded-byte cap is enforced), that run's structure-only evidence can
 * support further proposals. Nothing here sends a request.
 *
 * The source is identified by run, check ID, the check's definition hash at
 * execution, the target origin and the evidence file's digest (recorded in
 * the ledger when the evidence was written). A changed check definition
 * makes the evidence stale; a digest mismatch means it was altered.
 */
export class EvidenceDraftError extends Error {
  constructor(message: string, readonly code: "not-found" | "stale" | "cross-profile" | "invalid" | "tampered") {
    super(message);
    this.name = "EvidenceDraftError";
  }
}

const RUN_ID_RE = /^RUN-[A-Za-z0-9-]{1,80}$/;
const CHECK_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export type StructureEvidence = {
  evidence: "structure-only";
  profileId?: string;
  origin?: string;
  checkId?: string;
  checkDefinitionHash?: string;
  status: number;
  contentType: string;
  bodyRecorded: false;
  bodyShape: Record<string, string[]> | null;
  shapeOmissions?: string[];
  emptyArrays?: string[];
  note?: string;
};
export type StoredEvidence = { runId: string; checkId: string; evidence: StructureEvidence; sha256: string; entry: CheckLedgerEntry };

/** Reads one executed check's structure-only evidence and verifies it against the digest its run recorded. */
export function readCheckEvidence(runsRoot: string, runId: string, checkId: string): StoredEvidence {
  if (!RUN_ID_RE.test(runId) || !CHECK_ID_RE.test(checkId)) throw new EvidenceDraftError("Invalid run or check ID.", "invalid");
  const runDir = resolveArtifactPath(runsRoot, runId, ".");
  const ledgerPath = runDir ? join(runDir, "check-results.json") : undefined;
  if (!ledgerPath || !existsSync(ledgerPath)) throw new EvidenceDraftError("That run has no check results.", "not-found");
  let ledger: ChecksLedger;
  try { ledger = JSON.parse(readFileSync(ledgerPath, "utf-8")) as ChecksLedger; } catch { throw new EvidenceDraftError("The run's check results are not valid JSON.", "invalid"); }
  const entries = ledger.entries.filter((e) => e.kind === "api" && e.checkId === checkId);
  if (entries.length !== 1) throw new EvidenceDraftError(entries.length ? "The run has more than one result for that check; the source is ambiguous." : "That check did not run in that run.", entries.length ? "invalid" : "not-found");
  const entry = entries[0]!;
  const ref = entry.evidenceRefs.find((r) => r.endsWith("/response.json"));
  const digest = entry.evidenceDigests?.[ref ?? ""];
  if (!entry.ran || !ref || !digest) throw new EvidenceDraftError("That run has no digest-protected structure evidence for the check (it did not execute, or it ran before evidence digests were recorded). Run a suite containing the approved check again; the new run will record it.", "not-found");
  const path = resolveArtifactPath(runsRoot, runId, ref);
  if (!path || !existsSync(path)) throw new EvidenceDraftError("The evidence file is missing.", "not-found");
  const raw = readFileSync(path);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (sha256 !== digest) throw new EvidenceDraftError("The evidence file does not match the digest recorded when it was written; it was changed afterwards.", "tampered");
  let evidence: StructureEvidence;
  try { evidence = JSON.parse(raw.toString("utf-8")) as StructureEvidence; } catch { throw new EvidenceDraftError("The evidence file is not valid JSON.", "invalid"); }
  if (evidence.evidence !== "structure-only") throw new EvidenceDraftError("Only structure-only evidence can support proposals; this check keeps full bodies.", "invalid");
  return { runId, checkId, evidence, sha256, entry };
}

export type EvidenceProposal = { id: string; field: string; expected: "string" | "number" | "boolean" | "array" | "object"; provenance: string };
export type EvidenceDrafts = {
  checkId: string;
  source: { runId: string; checkId: string; checkDefinitionHash: string; origin: string; evidenceSha256: string };
  observedFacts: { status: number; contentType: string; samples: 1; emptyArrays: string[]; omissions: string[]; note?: string };
  proposals: EvidenceProposal[];
  limitations: string[];
};

const TOP_LEVEL_RE = /^\$\.([A-Za-z_][A-Za-z0-9_-]{0,63})$/;

/** Proposals from one executed response. Throws on cross-profile, other-origin, missing or stale sources. */
export function buildEvidenceDrafts(stored: StoredEvidence, profileId: string, targetOrigin: string, current: DeclaredApiCheck | undefined): EvidenceDrafts {
  const { evidence } = stored;
  if (evidence.profileId !== profileId) throw new EvidenceDraftError("That evidence was recorded for a different application.", "cross-profile");
  if (evidence.origin !== targetOrigin) throw new EvidenceDraftError("That evidence was recorded against a different origin than the application's current target.", "invalid");
  if (evidence.checkId !== stored.checkId) throw new EvidenceDraftError("The evidence names a different check; the source is ambiguous.", "invalid");
  if (!current) throw new EvidenceDraftError("That check is no longer an approved check of this application.", "not-found");
  const hash = checkDefinitionHash(current);
  if (evidence.checkDefinitionHash !== hash) throw new EvidenceDraftError("The check's definition changed after this evidence was recorded, so the evidence is stale. Run the current check again.", "stale");
  const asserted = new Set(Object.keys(current.assertions.shape ?? {}));
  const proposals: EvidenceProposal[] = [];
  for (const [path, types] of Object.entries(evidence.bodyShape ?? {})) {
    const field = TOP_LEVEL_RE.exec(path)?.[1];
    if (!field || asserted.has(field)) continue;
    const expected = types.length === 1 && ["string", "boolean", "array", "object"].includes(types[0]!) ? types[0] as EvidenceProposal["expected"]
      : types.length > 0 && types.every((t) => t === "integer" || t === "number") ? "number" : undefined;
    if (!expected) continue;
    proposals.push({ id: `shape:${field}`, field, expected, provenance: `type ${expected} in 1/1 executed response of ${stored.checkId} (run ${stored.runId})` });
  }
  return {
    checkId: stored.checkId,
    source: { runId: stored.runId, checkId: stored.checkId, checkDefinitionHash: hash, origin: evidence.origin!, evidenceSha256: stored.sha256 },
    observedFacts: { status: evidence.status, contentType: evidence.contentType, samples: 1, emptyArrays: evidence.emptyArrays ?? [], omissions: evidence.shapeOmissions ?? [], ...(evidence.note ? { note: evidence.note } : {}) },
    proposals,
    limitations: [
      "One executed response is a single sample: a type seen once is not shown to be fixed, and presence is not shown to be required.",
      "Names outside the generic vocabulary or the profile's apiObservation.knownFields are masked and never proposed.",
      "Arrays seen only empty say nothing about their elements; array contents are not proposed.",
      ...(evidence.shapeOmissions?.length ? [`The recorded shape was cut short (${evidence.shapeOmissions.join(", ")}).`] : []),
    ],
  };
}

/** The check with the approved shape assertions added. Every field must be a current proposal. */
export function withApprovedShape(current: DeclaredApiCheck, drafts: EvidenceDrafts, fields: string[]): DeclaredApiCheck {
  if (!fields.length) throw new EvidenceDraftError("Select at least one proposed assertion.", "invalid");
  const shape = { ...(current.assertions.shape ?? {}) };
  for (const field of fields) {
    const proposal = drafts.proposals.find((p) => p.field === field);
    if (!proposal) throw new EvidenceDraftError(`"${field}" is not a proposal from that evidence.`, "invalid");
    shape[field] = proposal.expected;
  }
  return { ...current, assertions: { ...current.assertions, shape } };
}
