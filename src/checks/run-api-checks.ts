import { join } from "node:path";
import type { DeclaredApiCheck } from "./checks-manifest.js";
import { checkBudget, createCheckRequester, scopedCheckUrl, sessionFields, type CheckBudget, type RunSession } from "./request-scope.js";
import { evaluateAssertions } from "./shape-check.js";
import { appendCheckLedgerEntry, writeCheckEvidence } from "./evidence.js";
import { generateFindingId } from "../report.js";
import { normalizePathname } from "../mapping/state-signature.js";
import type { CheckLedgerEntry } from "./types.js";
import type { Finding } from "../types.js";
import type { ProjectProfile } from "../profiles/schema.js";

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
      record(blockedEntry(check, "Finding budget exhausted before this check."));
      continue;
    }
    if (abortSignal?.aborted) {
      record(blockedEntry(check, "Run was cancelled before this check ran."));
      continue;
    }

    const isMutating = check.method !== "GET";
    const allowed = !isMutating || profile.apiChecks.allowedMutatingEndpoints.some((e) => e.method === check.method && e.pathname === check.pathname);
    if (!allowed) {
      record(blockedEntry(check, `${check.method} ${check.pathname} is a mutating request not present in apiChecks.allowedMutatingEndpoints.`));
      continue;
    }
    if (!scopedCheckUrl(profile, origin, check.pathname)) {
      record(blockedEntry(check, `${check.pathname} is outside navigation.allowedPathPrefixes.`));
      continue;
    }
    if (budget.used >= budget.max) {
      record(blockedEntry(check, "API request budget exhausted."));
      continue;
    }

    const beforeRequest = budget.used;
    const url = new URL(check.pathname, origin).toString();
    const response = await request(check.pathname, check.method, check.requestBody, profile.apiChecks.responseSizeCapBytes, abortSignal);

    if ("failed" in response) {
      record({ ...blockedEntry(check, response.reason), ran: budget.used > beforeRequest, observation: response.reason });
      continue;
    }

    const failures = evaluateAssertions(check.assertions, response.status, response.contentType, response.body);
    const requestSnapshot = { method: check.method, url, body: check.requestBody, sessionHeadersOmitted: profile.auth.mode !== "none" };
    const responseSnapshot = { status: response.status, headers: response.headers, body: response.body, truncated: response.bodyTruncated };

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
        classification: "passed",
        assertion: check.description,
        observation: `status ${response.status}, all declared assertions satisfied`,
        evidenceRefs: evidenceRefs.map((f) => `checks/${check.id}/${f}`),
      });
      continue;
    }

    // A second identical GET is the reproduction for a deterministic
    // declared check. A declared mutation is authorized once, never repeated.
    const beforeConfirm = budget.used;
    const confirm = check.method === "GET"
      ? await request(check.pathname, check.method, check.requestBody, profile.apiChecks.responseSizeCapBytes, abortSignal)
      : { failed: true as const, reason: "Automatic mutation replay is unsupported." };
    const confirmFailures = "failed" in confirm ? [] : evaluateAssertions(check.assertions, confirm.status, confirm.contentType, confirm.body);
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
      writeCheckEvidence(evidenceDir, "confirmation.json", confirm, extraSecrets),
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
      findingId,
    });
  }

  return { findings, nextFindingIndex: findingIndex };
}

function blockedEntry(check: DeclaredApiCheck, reason: string): CheckLedgerEntry {
  return {
    checkId: check.id,
    kind: "api",
    ran: false,
    blockedReason: reason,
    classification: "unsupported",
    assertion: check.description,
    observation: "Not run.",
    evidenceRefs: [],
  };
}
