import { join } from "node:path";
import type { DeclaredApiCheck } from "./checks-manifest.js";
import { fireCheckRequest } from "./http-client.js";
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
  abortSignal?: AbortSignal
): Promise<ApiChecksResult> {
  const findings: Finding[] = [];
  let findingIndex = startingFindingIndex;
  const maxRequests = profile.limits.maxApiRequests ?? profile.limits.maxActions;
  let requestsUsed = 0;

  for (const check of checks) {
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
    if (!check.pathname.startsWith("/") || !profile.navigation.allowedPathPrefixes.some((p) => check.pathname.startsWith(p))) {
      appendCheckLedgerEntry(runDir, blockedEntry(check, `${check.pathname} is outside navigation.allowedPathPrefixes.`), extraSecrets);
      continue;
    }
    if (requestsUsed >= maxRequests) {
      appendCheckLedgerEntry(runDir, blockedEntry(check, `API request budget exhausted (maxApiRequests=${maxRequests}).`), extraSecrets);
      continue;
    }

    requestsUsed++;
    const url = new URL(check.pathname, origin).toString();
    const response = await fireCheckRequest(url, check.method, check.requestBody, profile.apiChecks.responseSizeCapBytes, abortSignal);

    if ("failed" in response) {
      appendCheckLedgerEntry(runDir, blockedEntry(check, `Request failed: ${response.reason}`), extraSecrets);
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
    const confirm = await fireCheckRequest(url, check.method, check.requestBody, profile.apiChecks.responseSizeCapBytes, abortSignal);
    const confirmFailures = "failed" in confirm ? failures : evaluateAssertions(check.assertions, confirm.status, confirm.contentType, confirm.body);
    const classification = confirmFailures.length > 0 ? "confirmed" : "needs_review";
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

    const finding: Finding = {
      id: findingId,
      title: `Declared API check failed: ${check.description}`,
      status: "validated",
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
      reproduction: { attempts: 2, successes: confirmFailures.length > 0 ? 2 : 1 },
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
