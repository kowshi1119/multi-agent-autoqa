import { join } from "node:path";
import type { DeclaredSecurityCheck } from "./checks-manifest.js";
import { checkBudget, createCheckRequester, scopedCheckUrl, sessionFields, type CheckBudget, type RunSession } from "./request-scope.js";
import { appendCheckLedgerEntry, writeCheckEvidence } from "./evidence.js";
import { generateFindingId } from "../report.js";
import { normalizePathname } from "../mapping/state-signature.js";
import type { CheckClassification, CheckLedgerEntry } from "./types.js";
import type { Finding } from "../types.js";
import type { ProjectProfile } from "../profiles/schema.js";

export type SecurityChecksResult = { findings: Finding[]; nextFindingIndex: number };

const SECURITY_HEADERS = ["content-security-policy", "x-content-type-options", "x-frame-options", "strict-transport-security"];
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
      record(runDir, blockedEntry(check, "Finding budget exhausted before this check."), extraSecrets); continue;
    }
    if (abortSignal?.aborted) {
      record(runDir, blockedEntry(check, "Run was cancelled before this check ran."), extraSecrets);
      continue;
    }
    if (!scopedCheckUrl(profile, origin, check.pathname)) {
      record(runDir, blockedEntry(check, `${check.pathname} is outside navigation.allowedPathPrefixes.`), extraSecrets);
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
      record(runDir, { ...blockedEntry(check, response.reason), ran: budget.used > beforeRequest, observation: response.reason }, extraSecrets);
      continue;
    }

    const outcome = response.status < 200 || response.status >= 300
      ? { classification: "needs_review" as const, observation: "HTTP " + response.status + "; the declared resource was not successfully inspected.", expected: "Successful resource response", confidence: "low" as const, impact: "Error and redirect responses cannot establish a successful resource security check." }
      : check.kind === "cookie-attributes" ? evaluateCookieAttributes(response.setCookies) : check.kind === "security-headers" ? evaluateSecurityHeaders(response.headers) : evaluateSecretLeakage(response.body);
    const responseSnapshot = { status: response.status, headers: response.headers, bodyExcerpt: typeof response.body === "string" ? response.body.slice(0, 2000) : response.body };

    if (outcome.classification === "passed" || outcome.classification === "informational") {
      const evidenceDir = join(runDir, "checks", check.id);
      const evidenceRefs = [writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets)];
      record(runDir, { checkId: check.id, kind: "security", ran: true, classification: outcome.classification, assertion: check.description, observation: outcome.observation, evidenceRefs: evidenceRefs.map((f) => `checks/${check.id}/${f}`) }, extraSecrets);
      continue;
    }

    const findingId = generateFindingId(findingIndex++);
    const pathname = normalizePathname(url);
    // See run-api-checks.ts's matching comment: a Finding's evidence must
    // live under findings/<id>/ with bare filenames, matching every other
    // finding in the codebase and index.html's hardcoded evidence-link path.
    const evidenceDir = join(runDir, "findings", findingId);
    const evidenceFilenames = [writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets)];
    const finding: Finding = {
      id: findingId,
      title: `Security check: ${check.description}`,
      status: outcome.classification === "confirmed" ? "validated" : "needs_human",
      category: "security",
      pageId: "PAGE-SECURITY",
      url,
      pathname,
      expected: outcome.expected,
      actual: outcome.observation,
      oracle: { oracleId: `declared-security-check-${check.kind}`, suspicious: true, expected: outcome.expected, actual: outcome.observation, details: { checkId: check.id, classification: outcome.classification, confidence: outcome.confidence, impact: outcome.impact } },
      steps: [],
      reproduction: { attempts: 1, successes: 1 },
      occurrenceCount: 1,
      evidence: evidenceFilenames,
      evidenceLevel: "L6",
      reportDisposition: outcome.classification === "confirmed" ? "report" : "needs_human",
    };
    findings.push(finding);

    record(runDir, { checkId: check.id, kind: "security", ran: true, classification: outcome.classification, assertion: check.description, observation: outcome.observation, evidenceRefs: evidenceFilenames.map((f) => `findings/${findingId}/${f}`), findingId }, extraSecrets);
  }

  return { findings, nextFindingIndex: findingIndex };
}

type CheckOutcome = { classification: CheckClassification; observation: string; expected: string; confidence: "low" | "medium"; impact: string };

function evaluateCookieAttributes(cookies: string[]): CheckOutcome {
  if (!cookies.length) return { classification: "informational", observation: "No Set-Cookie header present on this response.", expected: "Session cookies carry HttpOnly/Secure/SameSite", confidence: "low", impact: "None observed here." };
  const missing = [...new Set(cookies.flatMap(cookie => {
    const attrs = new Map(cookie.split(";").slice(1).map(part => { const [key, ...value] = part.trim().split("="); return [(key ?? "").toLowerCase(), value.join("=").toLowerCase()]; }));
    return ["httponly", "secure", "samesite"].filter(attr => !attrs.has(attr) || (attr === "samesite" && !["strict", "lax", "none"].includes(attrs.get(attr) ?? "")));
  }))];
  if (missing.length === 0) return { classification: "passed", observation: "Set-Cookie carries HttpOnly, Secure, and SameSite.", expected: "", confidence: "medium", impact: "" };
  return {
    classification: "needs_review",
    observation: `Set-Cookie is missing: ${missing.join(", ")}.`,
    expected: "Session cookies should carry HttpOnly, Secure, and SameSite attributes.",
    confidence: "medium",
    impact: `Missing ${missing.join("/")} increases exposure to ${missing.includes("httponly") ? "script-based cookie theft (XSS)" : missing.includes("samesite") ? "cross-site request forgery" : "transport downgrade"}, but does not by itself prove an exploitable vulnerability -- context (deployment over HTTPS, other mitigations) matters.`,
  };
}

function evaluateSecurityHeaders(headers: Record<string, string>): CheckOutcome {
  const missing = SECURITY_HEADERS.filter((h) => !(h in headers));
  if (missing.length === 0) return { classification: "passed", observation: "All checked security headers are present.", expected: "", confidence: "medium", impact: "" };
  return {
    classification: "needs_review",
    observation: `Missing security header(s): ${missing.join(", ")}.`,
    expected: `Response should include: ${SECURITY_HEADERS.join(", ")}.`,
    confidence: "low",
    impact: "A missing security header is a defense-in-depth gap, not proof of an exploitable vulnerability by itself -- its real impact depends on the rest of the application's mitigations. Reported as needs_review, not a confirmed finding.",
  };
}

function evaluateSecretLeakage(body: unknown): CheckOutcome {
  // Structural check first -- catches a sensitive-named JSON field
  // (e.g. {"debugToken": "..."}) that a flat text/regex pass can't reach
  // because the JSON-quoted key breaks the "key:value" shape a plain
  // regex needs (the same gap redact-structured.ts closes for redaction).
  const structural = typeof body === "object" && body !== null ? findSecretByKey(body) : undefined;
  if (structural) {
    return {
      classification: "needs_review",
      // The value itself is never included, redacted or not -- it's
      // exactly the secret this check exists to catch, so there is no safe
      // partial disclosure of it (redactSecrets() only strips known
      // key=value/provider-key SHAPES, it can't redact an isolated bare
      // value it has no surrounding context for).
      observation: `Response body field "${structural.path}" holds a credential/token-shaped value (redacted).`,
      expected: "Response body should not contain credential- or token-shaped values.",
      confidence: "medium",
      impact: "A leaked token/credential in a response body can be used to impersonate the affected session or account if captured by an unintended party.",
    };
  }

  const text = typeof body === "string" ? body : JSON.stringify(body);
  const match = KEY_SHAPED_SECRET_RE.exec(text) ?? (typeof body === "string" ? KEY_VALUE_TEXT_SECRET_RE.exec(text) : null);
  if (!match) return { classification: "passed", observation: "No secret-shaped pattern found in the response body.", expected: "", confidence: "medium", impact: "" };
  return {
    classification: "needs_review",
    observation: "Response body contains a secret-shaped value (omitted). Context is required to establish unintended disclosure.",
    expected: "Response body should not contain credential- or token-shaped values.",
    confidence: "medium",
    impact: "A leaked token/credential in a response body can be used to impersonate the affected session or account if captured by an unintended party.",
  };
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
    record(runDir, blockedEntry(check, "Cross-account checks use their own seeded fixture sessions and are unsupported on authenticated profiles."), extraSecrets);
    return;
  }
  if (!boundary) {
    record(runDir, blockedEntry(check, "session-boundary check is missing its sessionBoundary configuration."), extraSecrets);
    return;
  }

  const base = new URL(origin);
  if (profile.target.environmentKind !== "local-fixture" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
      boundary.accountAId !== "demo-a" || boundary.accountBId !== "demo-b" ||
      boundary.loginPathname !== "/api/login-demo" || boundary.resourcePathnameTemplate !== "/api/account/{accountId}/resource") {
    record(runDir, blockedEntry(check, "Cross-account checks support only the two seeded local fixture accounts and fixed demo endpoints."), extraSecrets);
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
      record(runDir, blockedEntry(check, `${pathname} is outside navigation.allowedPathPrefixes.`), extraSecrets);
      return;
    }
  }

  const loginA = await request(boundary.loginPathname, "POST", { accountId: boundary.accountAId }, 65_536, abortSignal);
  if ("failed" in loginA) {
    record(runDir, blockedEntry(check, `Could not sign in as ${boundary.accountAId}: ${loginA.reason}`), extraSecrets);
    return;
  }
  const cookieA = loginA.status === 200 ? loginA.setCookies[0] : undefined;
  if (!cookieA) {
    record(runDir, blockedEntry(check, `Login as ${boundary.accountAId} did not return a session cookie.`), extraSecrets);
    return;
  }

  const url = new URL(bResourcePathname, origin).toString();
  // Establish B's resource exists under B's own distinct session first.
  const loginB = await request(boundary.loginPathname, "POST", { accountId: boundary.accountBId }, 65_536, abortSignal);
  const cookieB = "failed" in loginB || loginB.status !== 200 ? undefined : loginB.setCookies[0];
  if (!cookieB || cookieB.split(";")[0] === cookieA.split(";")[0]) {
    record(runDir, blockedEntry(check, "Could not establish two distinct seeded sessions."), extraSecrets); return;
  }
  const control = await request(bResourcePathname, "GET", undefined, 65_536, abortSignal, { cookie: cookieB.split(";")[0] as string });
  if ("failed" in control || control.status !== 200 || (control.body as { resourceOwner?: string } | null)?.resourceOwner !== boundary.accountBId) {
    record(runDir, blockedEntry(check, "Account B's resource control did not succeed."), extraSecrets); return;
  }
  const response = await request(bResourcePathname, "GET", undefined, 65_536, abortSignal, { cookie: cookieA.split(";")[0] as string });

  if ("failed" in response) {
    record(runDir, blockedEntry(check, `Cross-account request failed: ${response.reason}`), extraSecrets);
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
    record(runDir, { checkId: check.id, kind: "security", ran: true, classification: denied ? "passed" : "needs_review", assertion: check.description, observation: denied ? "Cross-account access explicitly denied after successful owner control." : "Cross-account response is inconclusive; HTTP " + response.status, evidenceRefs: evidenceRefs.map((f) => `checks/${check.id}/${f}`) }, extraSecrets);
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
  record(runDir, { checkId: check.id, kind: "security", ran: true, classification: "confirmed", assertion: check.description, observation: finding.actual, evidenceRefs: evidenceFilenames.map((f) => `findings/${findingId}/${f}`), findingId }, extraSecrets);
}

function blockedEntry(check: DeclaredSecurityCheck, reason: string): CheckLedgerEntry {
  return { checkId: check.id, kind: "security", ran: false, blockedReason: reason, classification: "unsupported", assertion: check.description, observation: "Not run.", evidenceRefs: [] };
}
