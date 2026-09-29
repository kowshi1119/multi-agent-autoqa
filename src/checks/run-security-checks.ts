import { join } from "node:path";
import type { DeclaredSecurityCheck } from "./checks-manifest.js";
import { checkBudget, createCheckRequester, scopedCheckUrl, sessionFields, type CheckBudget, type RunSession } from "./request-scope.js";
import { appendCheckLedgerEntry, writeCheckEvidence } from "./evidence.js";
import { generateFindingId } from "../report.js";
import { normalizePathname } from "../mapping/state-signature.js";
import type { CheckClassification, CheckLedgerEntry } from "./types.js";
import type { Finding } from "../types.js";
import type { ProjectProfile } from "../profiles/schema.js";
import { dedupKeyForFinding } from "../reporting/dedup.js";
import type { ReasonCode } from "../outcomes/outcome.js";
import { assessCookieAttributes, assessSecretLeakage, assessSecurityHeaders, notInspected, SECURITY_HEADERS } from "./security-assertions.js";

export type SecurityChecksResult = { findings: Finding[]; nextFindingIndex: number };

/** Distinctive provider/API-key shapes -- these need no surrounding key name, so a plain text scan (parsed body or raw string) reliably finds them regardless of JSON structure. */
const KEY_SHAPED_SECRET_RE = /(?:xpl_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]{35})/;
/** A "key=value" text shape (e.g. a URL query string or a flattened log line) -- same limitation as redact.ts's own flat pattern: cannot reach a JSON-quoted key. Used only against non-JSON string bodies. */
const KEY_VALUE_TEXT_SECRET_RE = /\b[a-z0-9_-]*(?:authorization|token|password|secret|cookie|api[_-]?key)[a-z0-9_-]*\s*[=:]\s*(?:bearer\s+)?[^\s,;"'<>}\]&]{6,}/i;
/** Sensitive object-key names -- walked structurally (see findSecretByKey below) so a JSON-quoted key like {"debugToken": "..."} is still caught, the same gap redact-structured.ts closes for redaction. */
const SENSITIVE_KEY_RE = /(?:authorization|token|password|secret|api[_-]?key)/i;

/** Recursively looks for a sensitive-named key holding a non-empty string value. Returns the first match found, or undefined. */
function findSecretByKey(value: unknown, path = ""): { path: string; value: string } | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findSecretByKey(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key) && typeof v === "string" && v.length > 0) return { path: path ? `${path}.${key}` : key, value: v };
      const found = findSecretByKey(v, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Passive/synthetic-only security checks: cookie attributes, security
 * response headers, response-body secret leakage, and a session-boundary
 * cross-account check using two SEEDED LOCAL demo accounts (declared in the
 * checks manifest -- never a real Ajeer account). No mutation, no fuzzing,
 * no credential guessing anywhere in this file. Every check always gets a
 * ledger entry, classified confirmed/needs_review/informational/
 * unsupported -- a missing header is never automatically "confirmed"/high-
 * severity, only "needs_review" with explicit context.
 *
 * `origin` is passed in explicitly, not derived from
 * profile.navigation.allowedOrigins[0] -- see run-api-checks.ts's matching
 * doc comment: a local-fixture profile's declared origin is inert
 * placeholder text once runPipeline() substitutes the real OS-assigned
 * port into its own AppConfig.
 */
export async function runSecurityChecks(
  profile: ProjectProfile,
  checks: DeclaredSecurityCheck[],
  runDir: string,
  startingFindingIndex: number,
  origin: string,
  extraSecrets: readonly string[] = [],
  abortSignal?: AbortSignal,
  budget: CheckBudget = checkBudget(profile),
  session?: RunSession
): Promise<SecurityChecksResult> {
  const findings: Finding[] = [];
  let findingIndex = startingFindingIndex;
  const request = createCheckRequester(profile, origin, budget, session);
  const record = (dir: string, entry: CheckLedgerEntry, secrets: readonly string[]): void => appendCheckLedgerEntry(dir, { ...entry, ...sessionFields(profile, session) }, secrets);

  for (const check of checks) {
    if (findingIndex > profile.limits.maxFindings) {
      record(runDir, blockedEntry(check, "budget-exhausted", "Finding budget exhausted before this check."), extraSecrets); continue;
    }
    if (abortSignal?.aborted) {
      record(runDir, blockedEntry(check, "cancelled", "Run was cancelled before this check ran."), extraSecrets);
      continue;
    }
    if (!scopedCheckUrl(profile, origin, check.pathname)) {
      record(runDir, blockedEntry(check, "scope-rejected", `${check.pathname} is outside navigation.allowedPathPrefixes.`), extraSecrets);
      continue;
    }

    if (check.kind === "session-boundary") {
      await runSessionBoundaryCheck(profile, check, origin, runDir, () => findingIndex++, findings, extraSecrets, abortSignal, budget);
      continue;
    }

    const url = new URL(check.pathname, origin).toString();
    const beforeRequest = budget.used;
    const response = await request(check.pathname, "GET", undefined, profile.apiChecks.responseSizeCapBytes, abortSignal);
    if ("failed" in response) {
      record(runDir, { ...blockedEntry(check, response.code, response.reason), ran: budget.used > beforeRequest, observation: response.reason }, extraSecrets);
      continue;
    }

    const ids = check.kind === "security-headers" ? SECURITY_HEADERS.map((h) => `header:${h}`) : check.kind === "cookie-attributes" ? ["cookie:any:present"] : ["secret:sensitive-field", "secret:key-shaped-value"];
    const assessment = response.status < 200 || response.status >= 300
      ? notInspected(ids, response.status)
      : check.kind === "cookie-attributes" ? assessCookieAttributes(response.setCookies, { origin })
      : check.kind === "security-headers" ? assessSecurityHeaders(response.headers, { origin })
      : assessSecretLeakage(response.body, typeof response.body === "object" && response.body !== null ? findSecretByKey(response.body) : undefined,
          KEY_SHAPED_SECRET_RE.test(typeof response.body === "string" ? response.body : JSON.stringify(response.body)),
          typeof response.body === "string" && KEY_VALUE_TEXT_SECRET_RE.test(response.body));
    const responseSnapshot = { status: response.status, headers: response.headers, bodyExcerpt: typeof response.body === "string" ? response.body.slice(0, 2000) : response.body };
    const failing = assessment.assertions.filter((a) => a.verdict === "fail");
    const notAssessed = assessment.assertions.filter((a) => a.verdict !== "pass" && a.verdict !== "fail");
    const summary = failing.length
      ? `${failing.length} of ${assessment.assertions.length} policy assertion(s) not met: ${failing.map((a) => `${a.id} (${a.observed})`).join("; ")}.`
      : notAssessed.length === assessment.assertions.length
        ? `No policy assertion could be assessed: ${notAssessed[0]?.observed ?? "nothing to inspect"}.`
        : `All assessed policy assertions met${notAssessed.length ? `; ${notAssessed.length} not assessed (${notAssessed.map((a) => a.id).join(", ")})` : ""}.`;

    if (!failing.length) {
      const evidenceDir = join(runDir, "checks", check.id);
      const evidenceRefs = [writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets)].map((f) => `checks/${check.id}/${f}`);
      record(runDir, {
        checkId: check.id, kind: "security", ran: true,
        classification: notAssessed.length ? "informational" : "passed",
        reasonCode: notAssessed.length === assessment.assertions.length ? (notAssessed[0]?.reasonCode ?? "not-applicable") : "ok",
        assertion: check.description, observation: summary, evidenceRefs,
        assertionModel: "per-assertion-v2",
        assertionResults: assessment.assertions.map((a) => ({ ...a, passed: a.verdict === "pass", evidenceRefs })),
      }, extraSecrets);
      continue;
    }

    // One finding per check, however many assertions failed: they describe one response, not independent vulnerabilities.
    const findingId = generateFindingId(findingIndex++);
    const pathname = normalizePathname(url);
    // See run-api-checks.ts's matching comment: a Finding's evidence must
    // live under findings/<id>/ with bare filenames, matching every other
    // finding in the codebase and index.html's hardcoded evidence-link path.
    const evidenceDir = join(runDir, "findings", findingId);
    const evidenceFilenames = [writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets)];
    const evidenceRefs = evidenceFilenames.map((f) => `findings/${findingId}/${f}`);
    const expected = failing.map((a) => `${a.assertion}: ${a.expected}`).join("; ");
    const finding: Finding = {
      id: findingId,
      title: `Security policy not met: ${check.description}`,
      status: "needs_human",
      category: "security",
      pageId: "PAGE-SECURITY",
      url,
      pathname,
      expected,
      actual: summary,
      oracle: { oracleId: `declared-security-check-${check.kind}`, suspicious: true, expected, actual: summary, details: { checkId: check.id, classification: "needs_review", failingAssertions: failing.map((a) => a.id), confidence: failing.every((a) => a.confidence === "high") ? "high" : "medium", impact: "Declared policy not met on this response; not proof of an exploitable vulnerability.", severityRationale: failing.map((a) => a.severityRationale).filter(Boolean)[0] } },
      steps: [],
      reproduction: { attempts: 1, successes: 1 },
      occurrenceCount: 1,
      evidence: evidenceFilenames,
      evidenceLevel: "L6",
      reportDisposition: "needs_human",
    };
    findings.push(finding);

    record(runDir, {
      checkId: check.id, kind: "security", ran: true, classification: "needs_review", reasonCode: "assertion-failed",
      assertion: check.description, observation: summary, evidenceRefs, findingId, findingFingerprint: dedupKeyForFinding(finding),
      assertionModel: "per-assertion-v2",
      assertionResults: assessment.assertions.map((a) => ({ ...a, passed: a.verdict === "pass", evidenceRefs })),
    }, extraSecrets);
  }

  return { findings, nextFindingIndex: findingIndex };
}

async function runSessionBoundaryCheck(
  profile: ProjectProfile,
  check: DeclaredSecurityCheck,
  origin: string,
  runDir: string,
  nextIndex: () => number,
  findings: Finding[],
  extraSecrets: readonly string[],
  abortSignal: AbortSignal | undefined,
  budget: CheckBudget
): Promise<void> {
  // Cross-account checks log in their own two seeded synthetic sessions and
  // never use (or mix with) a run's real authenticated session.
  const record = (dir: string, entry: CheckLedgerEntry, secrets: readonly string[]): void => appendCheckLedgerEntry(dir, { ...entry, session: "anonymous" }, secrets);
  const boundary = check.sessionBoundary;
  if (profile.auth.mode !== "none") {
    record(runDir, blockedEntry(check, "auth-unsupported", "Cross-account checks use their own seeded fixture sessions and are unsupported on authenticated profiles."), extraSecrets);
    return;
  }
  if (!boundary) {
    record(runDir, blockedEntry(check, "missing-configuration", "session-boundary check is missing its sessionBoundary configuration."), extraSecrets);
    return;
  }

  const base = new URL(origin);
  if (profile.target.environmentKind !== "local-fixture" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
      boundary.accountAId !== "demo-a" || boundary.accountBId !== "demo-b" ||
      boundary.loginPathname !== "/api/login-demo" || boundary.resourcePathnameTemplate !== "/api/account/{accountId}/resource") {
    record(runDir, blockedEntry(check, "scope-rejected", "Cross-account checks support only the two seeded local fixture accounts and fixed demo endpoints."), extraSecrets);
    return;
  }
  const request = createCheckRequester(profile, origin, budget);

  // The outer loop only validated check.pathname (a nominal label for this
  // check kind, "/" in the demo manifest) against allowedPathPrefixes --
  // the ACTUAL pathnames this sub-check fires against are the login/
  // resource ones below, which need the same gate applied to them directly.
  const bResourcePathname = boundary.resourcePathnameTemplate.replace("{accountId}", boundary.accountBId);
  for (const pathname of [boundary.loginPathname, bResourcePathname]) {
    if (!scopedCheckUrl(profile, origin, pathname)) {
      record(runDir, blockedEntry(check, "scope-rejected", `${pathname} is outside navigation.allowedPathPrefixes.`), extraSecrets);
      return;
    }
  }

  const loginA = await request(boundary.loginPathname, "POST", { accountId: boundary.accountAId }, 65_536, abortSignal);
  if ("failed" in loginA) {
    record(runDir, blockedEntry(check, loginA.code === "cancelled" ? "cancelled" : "auth-failed", `Could not sign in as ${boundary.accountAId}: ${loginA.reason}`), extraSecrets);
    return;
  }
  const cookieA = loginA.status === 200 ? loginA.setCookies[0] : undefined;
  if (!cookieA) {
    record(runDir, blockedEntry(check, "auth-failed", `Login as ${boundary.accountAId} did not return a session cookie.`), extraSecrets);
    return;
  }

  const url = new URL(bResourcePathname, origin).toString();
  // Establish B's resource exists under B's own distinct session first.
  const loginB = await request(boundary.loginPathname, "POST", { accountId: boundary.accountBId }, 65_536, abortSignal);
  const cookieB = "failed" in loginB || loginB.status !== 200 ? undefined : loginB.setCookies[0];
  if (!cookieB || cookieB.split(";")[0] === cookieA.split(";")[0]) {
    record(runDir, blockedEntry(check, "auth-failed", "Could not establish two distinct seeded sessions."), extraSecrets); return;
  }
  const control = await request(bResourcePathname, "GET", undefined, 65_536, abortSignal, { cookie: cookieB.split(";")[0] as string });
  if ("failed" in control || control.status !== 200 || (control.body as { resourceOwner?: string } | null)?.resourceOwner !== boundary.accountBId) {
    record(runDir, blockedEntry(check, "precondition-failed", "Account B's resource control did not succeed."), extraSecrets); return;
  }
  const response = await request(bResourcePathname, "GET", undefined, 65_536, abortSignal, { cookie: cookieA.split(";")[0] as string });

  if ("failed" in response) {
    record(runDir, blockedEntry(check, response.code, `Cross-account request failed: ${response.reason}`), extraSecrets);
    return;
  }

  const responseSnapshot = { status: response.status, body: response.body };
  const leaked = response.status === 200 && (response.body as { resourceOwner?: string } | null)?.resourceOwner === boundary.accountBId;
  const contextEvidence = { accountA: boundary.accountAId, accountB: boundary.accountBId, distinctSessionsEstablished: true, ownerControl: { status: control.status, body: control.body }, crossAccount: responseSnapshot, sessionValuesOmitted: true };
  if (!leaked) {
    const evidenceDir = join(runDir, "checks", check.id);
    const evidenceRefs = [writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets)];
    const denied = response.status === 401 || response.status === 403;
    evidenceRefs.push(writeCheckEvidence(evidenceDir, "session-context.json", contextEvidence, extraSecrets));
    const refs = evidenceRefs.map((f) => `checks/${check.id}/${f}`);
    record(runDir, {
      checkId: check.id, kind: "security", ran: true, classification: denied ? "passed" : "informational", reasonCode: denied ? "ok" : "precondition-failed",
      assertion: check.description, observation: denied ? "Cross-account access explicitly denied after successful owner control." : "Cross-account response is inconclusive; HTTP " + response.status, evidenceRefs: refs,
      assertionModel: "per-assertion-v2",
      assertionResults: [denied
        ? { id: "cross-account:denied", assertion: "Account A cannot read account B's resource", expected: "401/403", observed: `HTTP ${response.status}`, passed: true, verdict: "pass", reasonCode: "ok", confidence: "high", limitations: "Controlled synthetic fixture only.", evidenceRefs: refs }
        : { id: "cross-account:denied", assertion: "Account A cannot read account B's resource", expected: "401/403", observed: `HTTP ${response.status} (inconclusive)`, passed: false, verdict: "not-assessed", reasonCode: "precondition-failed", confidence: "low", limitations: "Neither a denial nor account B's data was observed; access control is not established either way.", evidenceRefs: refs }],
    }, extraSecrets);
    return;
  }

  const findingId = generateFindingId(nextIndex());
  const evidenceDir = join(runDir, "findings", findingId);
  const evidenceFilenames = [writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets)];
  evidenceFilenames.push(writeCheckEvidence(evidenceDir, "session-context.json", contextEvidence, extraSecrets));
  const finding: Finding = {
    id: findingId,
    title: `Security check: ${check.description}`,
    status: "validated",
    category: "security",
    pageId: "PAGE-SECURITY",
    url,
    pathname: normalizePathname(url),
    expected: `${boundary.accountAId}'s session should not be able to read ${boundary.accountBId}'s resource.`,
    actual: `${boundary.accountAId}'s session received a 200 response for ${boundary.accountBId}'s resource.`,
    oracle: { oracleId: "declared-security-check-session-boundary", suspicious: true, expected: "cross-account access denied", actual: "cross-account access allowed", details: { checkId: check.id } },
    steps: [],
    reproduction: { attempts: 1, successes: 1 },
    occurrenceCount: 1,
    evidence: evidenceFilenames,
    evidenceLevel: "L1",
    reportDisposition: "report",
  };
  findings.push(finding);
  const refs = evidenceFilenames.map((f) => `findings/${findingId}/${f}`);
  record(runDir, {
    checkId: check.id, kind: "security", ran: true, classification: "confirmed", reasonCode: "assertion-failed", assertion: check.description, observation: finding.actual, evidenceRefs: refs, findingId, findingFingerprint: dedupKeyForFinding(finding),
    assertionModel: "per-assertion-v2",
    assertionResults: [{ id: "cross-account:denied", assertion: "Account A cannot read account B's resource", expected: "401/403", observed: "HTTP 200 with account B's resource (owner field only recorded)", passed: false, verdict: "fail", reasonCode: "assertion-failed", confidence: "high", limitations: "Demonstrated on a controlled synthetic fixture with seeded accounts only.", severityRationale: "Demonstrated cross-account read of another account's resource: high, because unauthorized data access was observed, not inferred.", evidenceRefs: refs }],
  }, extraSecrets);
}

function blockedEntry(check: DeclaredSecurityCheck, reasonCode: ReasonCode, reason: string): CheckLedgerEntry {
  return { checkId: check.id, kind: "security", ran: false, blockedReason: reason, reasonCode, classification: "unsupported", assertion: check.description, observation: "Not run.", evidenceRefs: [] };
}
