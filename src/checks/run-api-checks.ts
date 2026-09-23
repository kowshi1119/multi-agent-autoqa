import { join } from "node:path";
import type { DeclaredApiCheck } from "./checks-manifest.js";
import { checkBudget, createCheckRequester, scopedCheckUrl, type CheckBudget } from "./request-scope.js";
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
 * evaluates its assertions deterministically, and turns a confirmed/
 * needs_review result into a standard Finding -- everything else (ran vs.
 * blocked, classification, evidence) is recorded in the run's
 * check-results.json ledger regardless of whether a Finding was created.
 * Policy gate: GET is always allowed under navigation.allowedPathPrefixes;
 * a mutating method requires an explicit entry in
 * profile.apiChecks.allowedMutatingEndpoints -- a separate allowlist from
 * resources.allowedFormSubmitEndpoints, which scopes browser-originated
 * requests only, not the standalone calls this function fires itself.
 *
 * `origin` is passed in explicitly rather than derived from
 * profile.navigation.allowedOrigins[0] -- for a "local-fixture" profile,
 * runPipeline() always binds the fixture server to an OS-assigned port and
 * substitutes the REAL origin into its own (mutated) AppConfig, leaving
 * the profile's own declared origin as inert placeholder text (see
 * run-pipeline.ts's 2026-09-16 port-isolation fix). The caller must read
 * the actual resolved origin off that same config, not this profile.
 */
export async function runApiChecks(
  profile: ProjectProfile,
  checks: DeclaredApiCheck[],
  runDir: string,
  startingFindingIndex: number,
  origin: string,
  extraSecrets: readonly string[] = [],
  abortSignal?: AbortSignal,
  budget: CheckBudget = checkBudget(profile)
): Promise<ApiChecksResult> {
  const findings: Finding[] = [];
  let findingIndex = startingFindingIndex;
  const request = createCheckRequester(profile, origin, budget);

  for (const check of checks) {
    if (findingIndex > profile.limits.maxFindings) {
      appendCheckLedgerEntry(runDir, blockedEntry(check, "Finding budget exhausted before this check."), extraSecrets); continue;
    }
    if (abortSignal?.aborted) {
      appendCheckLedgerEntry(runDir, blockedEntry(check, "Run was cancelled before this check ran."), extraSecrets);
      continue;
    }

    const isMutating = check.method !== "GET";
    const allowed = !isMutating || profile.apiChecks.allowedMutatingEndpoints.some((e) => e.method === check.method && e.pathname === check.pathname);
    if (!allowed) {
      appendCheckLedgerEntry(
        runDir,
        blockedEntry(check, `${check.method} ${check.pathname} is a mutating request not present in apiChecks.allowedMutatingEndpoints.`),
        extraSecrets
      );
      continue;
    }
    if (!scopedCheckUrl(profile, origin, check.pathname)) {
      appendCheckLedgerEntry(runDir, blockedEntry(check, `${check.pathname} is outside navigation.allowedPathPrefixes.`), extraSecrets);
      continue;
    }
    if (budget.used >= budget.max) {
      appendCheckLedgerEntry(runDir, blockedEntry(check, "API request budget exhausted."), extraSecrets);
      continue;
    }

    const beforeRequest = budget.used;
    const url = new URL(check.pathname, origin).toString();
    const response = await request(check.pathname, check.method, check.requestBody, profile.apiChecks.responseSizeCapBytes, abortSignal);

    if ("failed" in response) {
      appendCheckLedgerEntry(runDir, { ...blockedEntry(check, response.reason), ran: budget.used > beforeRequest, observation: response.reason }, extraSecrets);
      continue;
    }

    const failures = evaluateAssertions(check.assertions, response.status, response.contentType, response.body);
    const requestSnapshot = { method: check.method, url, body: check.requestBody };
    const responseSnapshot = { status: response.status, headers: response.headers, body: response.body, truncated: response.bodyTruncated };

    if (failures.length === 0) {
      // No Finding for a passing check -- its evidence lives in the
      // checks/ namespace, not findings/, and is reached through the
      // checks panel's own evidenceRefs (full run-relative paths), not the
      // finding-card evidence renderer.
      const evidenceDir = join(runDir, "checks", check.id);
      const evidenceRefs = [
        writeCheckEvidence(evidenceDir, "request.json", requestSnapshot, extraSecrets),
        writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets),
      ];
      appendCheckLedgerEntry(
        runDir,
        {
          checkId: check.id,
          kind: "api",
          ran: true,
          classification: "passed",
          assertion: check.description,
          observation: `status ${response.status}, all ${Object.keys(check.assertions).length} assertion group(s) satisfied`,
          evidenceRefs: evidenceRefs.map((f) => `checks/${check.id}/${f}`),
        },
        extraSecrets
      );
      continue;
    }

    // A second confirming fire, same as the first, IS the reproduction for
    // a deterministic declared HTTP check -- no browser replay needed.
    // A declared mutation is authorized once, never implicitly repeated.
    const beforeConfirm = budget.used;
    const confirm = check.method === "GET"
      ? await request(check.pathname, check.method, check.requestBody, profile.apiChecks.responseSizeCapBytes, abortSignal)
      : { failed: true as const, reason: "Automatic mutation replay is unsupported." };
    const confirmFailures = "failed" in confirm ? [] : evaluateAssertions(check.assertions, confirm.status, confirm.contentType, confirm.body);
    const reproduced = confirmFailures.some(c => failures.some(f => f.assertion === c.assertion && f.detail === c.detail));
    const classification = reproduced ? "confirmed" : "needs_review";
    const findingId = generateFindingId(findingIndex++);
    const pathname = normalizePathname(url);

    // A Finding's evidence directory/filename convention (findings/<id>/)
    // is shared with every other finding in the codebase (see
    // src/evidence.ts::writeFindingEvidence and every orchestrator/
    // validator call site) -- index.html's buildEvidenceLinks()/artifactUrl()
    // hardcode exactly this path, so a check-created Finding must follow it
    // too for its evidence links to resolve, rather than inventing a
    // second, incompatible evidence-path convention.
    const evidenceDir = join(runDir, "findings", findingId);
    const evidenceFilenames = [
      writeCheckEvidence(evidenceDir, "request.json", requestSnapshot, extraSecrets),
      writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets),
    ];

    evidenceFilenames.push(writeCheckEvidence(evidenceDir, "confirmation.json", confirm, extraSecrets));
    const finding: Finding = {
      id: findingId,
      title: `Declared API check failed: ${check.description}`,
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
        details: { checkId: check.id, classification, assertionsFailed: failures },
      },
      steps: [],
      reproduction: { attempts: 1 + (budget.used - beforeConfirm), successes: reproduced ? 2 : 1 },
      occurrenceCount: 1,
      evidence: evidenceFilenames,
      evidenceLevel: "L2",
      reportDisposition: classification === "confirmed" ? "report" : "needs_human",
    };
    findings.push(finding);

    appendCheckLedgerEntry(
      runDir,
      {
        checkId: check.id,
        kind: "api",
        ran: true,
        classification,
        assertion: check.description,
        observation: `${failures.length} assertion(s) failed: ${failures.map((f) => `${f.assertion} (${f.detail})`).join("; ")}`,
        evidenceRefs: evidenceFilenames.map((f) => `findings/${findingId}/${f}`),
        findingId,
      },
      extraSecrets
    );
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
