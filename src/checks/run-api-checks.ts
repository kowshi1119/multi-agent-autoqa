import { profileEvidenceMode } from "../privacy/evidence-policy.js";
import { join } from "node:path";
import type { DeclaredApiCheck } from "./checks-manifest.js";
import { checkBudget, createCheckRequester, scopedCheckUrl, sessionFields, type CheckBudget, type RunSession } from "./request-scope.js";
import { evaluateAssertionResults, evaluateAssertions } from "./shape-check.js";
import { evaluateContract } from "../contracts/openapi.js";
import type { AssertionOutcome } from "../outcomes/outcome.js";
import { dedupKeyForFinding } from "../reporting/dedup.js";
import { appendCheckLedgerEntry, writeCheckEvidence } from "./evidence.js";
import { generateFindingId } from "../report.js";
import { normalizePathname } from "../mapping/state-signature.js";
import type { CheckLedgerEntry } from "./types.js";
import type { ReasonCode } from "../outcomes/outcome.js";
import type { Finding } from "../types.js";
import type { ProjectProfile } from "../profiles/schema.js";
import { safeMediaType, walkShape } from "../auth/api-observer.js";
import type { CheckHttpResponse, CheckHttpError } from "./http-client.js";
import { checkDefinitionHash } from "../suites/suite-manifest.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type ApiChecksResult = { findings: Finding[]; nextFindingIndex: number };

/**
 * Fires every declared API check directly (no browser action involved),
 * evaluates its assertions deterministically, and records every check --
 * ran or blocked -- in the run's check-results.json ledger. Policy gate:
 * GET is always allowed within scope; a mutating method requires an
 * explicit entry in profile.apiChecks.allowedMutatingEndpoints (separate
 * from resources.allowedFormSubmitEndpoints, which scopes browser-originated
 * requests only).
 *
 * `origin` is the run's REAL resolved origin (a local-fixture profile's
 * declared port is placeholder text; see run-pipeline.ts). `session` is the
 * run's own live authenticated session, supplied only while that session's
 * browser context is still open; without it, a form-login profile's checks
 * are recorded as unsupported and nothing is sent anonymously.
 *
 * A reproduced mismatch is an ASSERTION mismatch against a human-authored
 * expectation, not by itself a product defect -- the expectation may be
 * wrong -- so it is routed to human review rather than reported directly.
 */
export async function runApiChecks(
  profile: ProjectProfile,
  checks: DeclaredApiCheck[],
  runDir: string,
  startingFindingIndex: number,
  origin: string,
  extraSecrets: readonly string[] = [],
  abortSignal?: AbortSignal,
  budget: CheckBudget = checkBudget(profile),
  session?: RunSession
): Promise<ApiChecksResult> {
  const findings: Finding[] = [];
  let findingIndex = startingFindingIndex;
  const request = createCheckRequester(profile, origin, budget, session);
  const record = (entry: CheckLedgerEntry): void => appendCheckLedgerEntry(runDir, { ...entry, ...sessionFields(profile, session) }, extraSecrets);

  for (const check of checks) {
    if (findingIndex > profile.limits.maxFindings) {
      record(blockedEntry(check, "budget-exhausted", "Finding budget exhausted before this check."));
      continue;
    }
    if (abortSignal?.aborted) {
      record(blockedEntry(check, "cancelled", "Run was cancelled before this check ran."));
      continue;
    }

    const isMutating = check.method !== "GET";
    const allowed = !isMutating || profile.apiChecks.allowedMutatingEndpoints.some((e) => e.method === check.method && e.pathname === check.pathname);
    if (!allowed) {
      record(blockedEntry(check, "not-authorized", `${check.method} ${check.pathname} is a mutating request not present in apiChecks.allowedMutatingEndpoints.`));
      continue;
    }
    if (!scopedCheckUrl(profile, origin, check.pathname)) {
      record(blockedEntry(check, "scope-rejected", `${check.pathname} is outside navigation.allowedPathPrefixes.`));
      continue;
    }
    if (budget.used >= budget.max) {
      record(blockedEntry(check, "budget-exhausted", "API request budget exhausted."));
      continue;
    }

    const beforeRequest = budget.used;
    const url = new URL(check.pathname, origin).toString();
    if (check.contract && check.method !== "GET") {
      record(blockedEntry(check, "not-authorized", "Contract checks are executable only for GET operations; importing a contract never authorizes a mutation."));
      continue;
    }
    const response = structureView(check, await request(check.pathname, check.method, check.requestBody, profile.apiChecks.responseSizeCapBytes, abortSignal, undefined, check.query));

    if ("failed" in response) {
      record({ ...blockedEntry(check, response.code, response.reason), ran: budget.used > beforeRequest, observation: response.reason });
      continue;
    }

    const results = evaluateCheck(check, response);
    const failures = failureList(check, response, results);
    const gaps = results.filter((r) => r.verdict === "unsupported" || r.verdict === "not-assessed");
    const requestSnapshot = { method: check.method, url, body: check.requestBody, sessionHeadersOmitted: profile.auth.mode !== "none" };
    const responseSnapshot = responseEvidence(check, profile, origin, response);

    if (failures.length === 0) {
      // No Finding for a passing check: its evidence lives under checks/,
      // reached through the ledger's run-relative evidenceRefs.
      const evidenceDir = join(runDir, "checks", check.id);
      const evidenceRefs = [
        writeCheckEvidence(evidenceDir, "request.json", requestSnapshot, extraSecrets),
        writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets),
      ];
      record({
        checkId: check.id,
        kind: "api",
        ran: true,
        classification: gaps.length ? "informational" : "passed",
        reasonCode: gaps.length ? (gaps.every((g) => g.reasonCode === "bounds-exceeded") ? "bounds-exceeded" : "unsupported-validation") : "ok",
        assertion: check.description,
        observation: gaps.length ? `status ${response.status}; no assertion failed, but ${gaps.length} could not be validated (${gaps.map((g) => g.id).slice(0, 5).join(", ")}${gaps.length > 5 ? ", …" : ""}) — not a pass` : `status ${response.status}, all declared assertions satisfied`,
        assertionResults: results.map(toLedgerAssertion),
        evidenceRefs: evidenceRefs.map((f) => `checks/${check.id}/${f}`),
        evidenceDigests: digests(runDir, evidenceRefs.map((f) => `checks/${check.id}/${f}`)),
      });
      continue;
    }

    // A second identical GET is the reproduction for a deterministic
    // declared check. A declared mutation is authorized once, never repeated.
    const beforeConfirm = budget.used;
    const confirm = check.method === "GET"
      ? structureView(check, await request(check.pathname, check.method, check.requestBody, profile.apiChecks.responseSizeCapBytes, abortSignal, undefined, check.query))
      : { failed: true as const, reason: "Automatic mutation replay is unsupported." };
    const confirmFailures = "failed" in confirm ? [] : failureList(check, confirm, evaluateCheck(check, confirm));
    const confirmSnapshot = "failed" in confirm ? confirm : responseEvidence(check, profile, origin, confirm);
    const reproduced = confirmFailures.some(c => failures.some(f => f.assertion === c.assertion && f.detail === c.detail));
    const classification = reproduced ? "confirmed" : "needs_review";
    const findingId = generateFindingId(findingIndex++);
    const pathname = normalizePathname(url);

    // findings/<id>/ with bare filenames: the convention every finding
    // uses and index.html's evidence-link renderer assumes.
    const evidenceDir = join(runDir, "findings", findingId);
    const evidenceFilenames = [
      writeCheckEvidence(evidenceDir, "request.json", requestSnapshot, extraSecrets),
      writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets),
      writeCheckEvidence(evidenceDir, "confirmation.json", confirmSnapshot, extraSecrets),
    ];
    const finding: Finding = {
      id: findingId,
      title: `Declared API assertion mismatch${reproduced ? " (reproduced)" : ""}: ${check.description}`,
      status: reproduced ? "validated" : "needs_human",
      category: "api",
      pageId: "PAGE-API",
      url,
      pathname,
      expected: failures.map((f) => f.assertion).join("; "),
      actual: failures.map((f) => f.detail).join("; "),
      oracle: {
        oracleId: "declared-api-check",
        suspicious: true,
        expected: failures.map((f) => f.assertion).join("; "),
        actual: failures.map((f) => f.detail).join("; "),
        details: { checkId: check.id, classification, assertionsFailed: failures, note: "A reproduced mismatch means the response disagreed with the declared expectation twice; whether that is a product defect depends on whether the expectation is correct." },
      },
      steps: [],
      reproduction: { attempts: 1 + (budget.used - beforeConfirm), successes: reproduced ? 2 : 1 },
      occurrenceCount: 1,
      evidence: evidenceFilenames,
      evidenceLevel: "L2",
      reportDisposition: "needs_human",
    };
    findings.push(finding);

    const confirmNote = "failed" in confirm ? ` Confirmation not evaluated: ${confirm.reason}` : "";
    record({
      checkId: check.id,
      kind: "api",
      ran: true,
      classification,
      assertion: check.description,
      observation: `${failures.length} assertion(s) failed: ${failures.map((f) => `${f.assertion} (${f.detail})`).join("; ")}.${confirmNote}`,
      evidenceRefs: evidenceFilenames.map((f) => `findings/${findingId}/${f}`),
      evidenceDigests: digests(runDir, evidenceFilenames.map((f) => `findings/${findingId}/${f}`)),
      findingId,
      findingFingerprint: dedupKeyForFinding(finding),
      reasonCode: results.some((r) => r.reasonCode === "malformed-response" && r.verdict === "fail") ? "malformed-response" : "assertion-failed",
      assertionResults: results.map(toLedgerAssertion),
      attempts: { total: "failed" in confirm ? 1 : 2, failed: "failed" in confirm ? 1 : confirmFailures.length ? 2 : 1 },
    });
  }

  return { findings, nextFindingIndex: findingIndex };
}

/**
 * What a check's evidence keeps of a response. "structure-only" checks
 * (e.g. approved from a passive observation) keep status, media type and
 * the body's shape -- names the check asserts or the profile configures,
 * other names masked, types only -- and never the body or other headers.
 */
/** Structure-only checks compare and report the media type only, so header parameters never reach findings or the ledger. */
/**
 * Structure-only evidence: declared on the check, or forced for every check
 * when the profile's evidence policy is minimal (response bodies are never
 * persisted for real targets by default).
 */
function structureOnly(check: DeclaredApiCheck, profile: ProjectProfile | undefined): boolean {
  return check.evidence === "structure-only" || (profile !== undefined && profileEvidenceMode(profile) === "minimal");
}

function structureView<T extends CheckHttpResponse | CheckHttpError | { failed: true; reason: string }>(check: DeclaredApiCheck, response: T): T {
  if ("failed" in response || !structureOnly(check, undefined)) return response;
  return { ...response, contentType: safeMediaType((response as CheckHttpResponse).contentType) || undefined };
}

/** sha256 of each written evidence file (run-relative path → digest), recorded in the ledger. */
function digests(runDir: string, refs: string[]): Record<string, string> {
  return Object.fromEntries(refs.map((ref) => [ref, createHash("sha256").update(readFileSync(join(runDir, ref))).digest("hex")]));
}

function responseEvidence(check: DeclaredApiCheck, profile: ProjectProfile, origin: string, response: CheckHttpResponse | (CheckHttpError & Record<string, unknown>)) {
  if ("failed" in response) return response;
  if (!structureOnly(check, profile)) return { status: response.status, headers: response.headers, body: response.body, truncated: response.bodyTruncated };
  const known = new Set([...(profile.apiObservation?.knownFields ?? []), ...Object.keys(check.assertions.shape ?? {}).flatMap((p) => p.split(".")), ...(check.assertions.requiredFields ?? []).flatMap((p) => p.split("."))]);
  const walk = typeof response.body === "object" && response.body !== null && !response.jsonParseFailed ? walkShape(response.body, known) : undefined;
  const bodyShape = walk ? Object.fromEntries([...walk.paths].map(([p, t]) => [p, [...t].sort()])) : null;
  // Identity of the source, so this evidence can later support reviewed proposals (src/checks/evidence-drafts.ts).
  const identity = { profileId: profile.id, origin, checkId: check.id, checkDefinitionHash: checkDefinitionHash(check) };
  return {
    evidence: "structure-only",
    ...identity,
    status: response.status,
    contentType: safeMediaType(response.contentType),
    bodyRecorded: false,
    ...(walk && bodyShape
      ? { bodyShape, shapeOmissions: [...walk.omissions], emptyArrays: Object.keys(bodyShape).filter((p) => bodyShape[p]!.includes("array") && !(`${p}[*]` in bodyShape)) }
      : { bodyShape: null, note: response.jsonParseFailed ? "Body did not parse as JSON." : "Body is not a JSON object or array." }),
  };
}

function blockedEntry(check: DeclaredApiCheck, reasonCode: ReasonCode, reason: string): CheckLedgerEntry {
  return {
    checkId: check.id,
    kind: "api",
    ran: false,
    blockedReason: reason,
    reasonCode,
    classification: "unsupported",
    assertion: check.description,
    observation: "Not run.",
    evidenceRefs: [],
  };
}

/** Declared assertions plus, for contract checks, the contract's own per-assertion results (stable ids, no response values). */
function evaluateCheck(check: DeclaredApiCheck, response: { status: number; contentType: string | undefined; body: unknown; jsonParseFailed?: boolean }): AssertionOutcome[] {
  const declared: AssertionOutcome[] = evaluateAssertionResults(check.assertions, response.status, response.contentType, response.body)
    .map((a) => ({ ...a, verdict: a.passed ? "pass" as const : "fail" as const, reasonCode: a.passed ? "ok" as const : "assertion-failed" as const }));
  return check.contract ? [...declared, ...evaluateContract(check.contract, response)] : declared;
}

function toLedgerAssertion(a: AssertionOutcome) {
  return { ...a, passed: a.verdict === "pass" };
}

/** Failure lines for findings and the ledger: declared assertions keep their established wording; contract failures follow. */
function failureList(check: DeclaredApiCheck, response: { status: number; contentType: string | undefined; body: unknown }, results: AssertionOutcome[]) {
  return [
    ...evaluateAssertions(check.assertions, response.status, response.contentType, response.body),
    ...results.filter((r) => r.id.startsWith("contract:") && r.verdict === "fail").map((r) => ({ id: r.id, assertion: r.id, detail: r.observed })),
  ];
}
