import { join } from "node:path";
import type { DeclaredSecurityCheck } from "./checks-manifest.js";
import { fireCheckRequest } from "./http-client.js";
import { appendCheckLedgerEntry, writeCheckEvidence } from "./evidence.js";
import { generateFindingId } from "../report.js";
import { normalizePathname } from "../mapping/state-signature.js";
import { redactSecrets } from "../redact.js";
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
  abortSignal?: AbortSignal
): Promise<SecurityChecksResult> {
  const findings: Finding[] = [];
  let findingIndex = startingFindingIndex;

  for (const check of checks) {
    if (abortSignal?.aborted) {
      appendCheckLedgerEntry(runDir, blockedEntry(check, "Run was cancelled before this check ran."), extraSecrets);
      continue;
    }
    if (!profile.navigation.allowedPathPrefixes.some((p) => check.pathname.startsWith(p))) {
      appendCheckLedgerEntry(runDir, blockedEntry(check, `${check.pathname} is outside navigation.allowedPathPrefixes.`), extraSecrets);
      continue;
    }

    if (check.kind === "session-boundary") {
      await runSessionBoundaryCheck(profile, check, origin, runDir, () => findingIndex++, findings, extraSecrets, abortSignal);
      continue;
    }

    const url = new URL(check.pathname, origin).toString();
    const response = await fireCheckRequest(url, "GET", undefined, 262_144, abortSignal);
    if ("failed" in response) {
      appendCheckLedgerEntry(runDir, blockedEntry(check, `Request failed: ${response.reason}`), extraSecrets);
      continue;
    }

    const outcome = check.kind === "cookie-attributes" ? evaluateCookieAttributes(response.headers) : check.kind === "security-headers" ? evaluateSecurityHeaders(response.headers) : evaluateSecretLeakage(response.body);
    const responseSnapshot = { status: response.status, headers: response.headers, bodyExcerpt: typeof response.body === "string" ? response.body.slice(0, 2000) : response.body };

    if (outcome.classification === "passed") {
      const evidenceDir = join(runDir, "checks", check.id);
      const evidenceRefs = [writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets)];
      appendCheckLedgerEntry(runDir, { checkId: check.id, kind: "security", ran: true, classification: "passed", assertion: check.description, observation: outcome.observation, evidenceRefs: evidenceRefs.map((f) => `checks/${check.id}/${f}`) }, extraSecrets);
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
      status: "validated",
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

    appendCheckLedgerEntry(runDir, { checkId: check.id, kind: "security", ran: true, classification: outcome.classification, assertion: check.description, observation: outcome.observation, evidenceRefs: evidenceFilenames.map((f) => `findings/${findingId}/${f}`), findingId }, extraSecrets);
  }

  return { findings, nextFindingIndex: findingIndex };
}

type CheckOutcome = { classification: CheckClassification; observation: string; expected: string; confidence: "low" | "medium"; impact: string };

function evaluateCookieAttributes(headers: Record<string, string>): CheckOutcome {
  const setCookie = headers["set-cookie"];
  if (!setCookie) return { classification: "informational", observation: "No Set-Cookie header present on this response.", expected: "Session cookies carry HttpOnly/Secure/SameSite", confidence: "low", impact: "None observed here." };
  const missing = ["httponly", "secure", "samesite"].filter((attr) => !setCookie.toLowerCase().includes(attr));
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
      classification: "confirmed",
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
    classification: "confirmed",
    observation: `Response body contains a secret-shaped value: ${redactSecrets(match[0])}.`,
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
  abortSignal?: AbortSignal
): Promise<void> {
  const boundary = check.sessionBoundary;
  if (!boundary) {
    appendCheckLedgerEntry(runDir, blockedEntry(check, "session-boundary check is missing its sessionBoundary configuration."), extraSecrets);
    return;
  }

  // The outer loop only validated check.pathname (a nominal label for this
  // check kind, "/" in the demo manifest) against allowedPathPrefixes --
  // the ACTUAL pathnames this sub-check fires against are the login/
  // resource ones below, which need the same gate applied to them directly.
  const bResourcePathname = boundary.resourcePathnameTemplate.replace("{accountId}", boundary.accountBId);
  for (const pathname of [boundary.loginPathname, bResourcePathname]) {
    if (!profile.navigation.allowedPathPrefixes.some((p) => pathname.startsWith(p))) {
      appendCheckLedgerEntry(runDir, blockedEntry(check, `${pathname} is outside navigation.allowedPathPrefixes.`), extraSecrets);
      return;
    }
  }

  const loginA = await fireCheckRequest(new URL(boundary.loginPathname, origin).toString(), "POST", { accountId: boundary.accountAId }, 65_536, abortSignal);
  if ("failed" in loginA) {
    appendCheckLedgerEntry(runDir, blockedEntry(check, `Could not sign in as ${boundary.accountAId}: ${loginA.reason}`), extraSecrets);
    return;
  }
  const cookieA = loginA.headers["set-cookie"];
  if (!cookieA) {
    appendCheckLedgerEntry(runDir, blockedEntry(check, `Login as ${boundary.accountAId} did not return a session cookie.`), extraSecrets);
    return;
  }

  const url = new URL(bResourcePathname, origin).toString();
  const response = await fireCheckRequest(url, "GET", undefined, 65_536, abortSignal, { cookie: cookieA.split(";")[0] as string });

  if ("failed" in response) {
    appendCheckLedgerEntry(runDir, blockedEntry(check, `Cross-account request failed: ${response.reason}`), extraSecrets);
    return;
  }

  const responseSnapshot = { status: response.status, body: response.body };
  const leaked = response.status === 200;
  if (!leaked) {
    const evidenceDir = join(runDir, "checks", check.id);
    const evidenceRefs = [writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets)];
    appendCheckLedgerEntry(runDir, { checkId: check.id, kind: "security", ran: true, classification: "passed", assertion: check.description, observation: `Account A's session was correctly denied access to account B's resource (status ${response.status}).`, evidenceRefs: evidenceRefs.map((f) => `checks/${check.id}/${f}`) }, extraSecrets);
    return;
  }

  const findingId = generateFindingId(nextIndex());
  const evidenceDir = join(runDir, "findings", findingId);
  const evidenceFilenames = [writeCheckEvidence(evidenceDir, "response.json", responseSnapshot, extraSecrets)];
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
  appendCheckLedgerEntry(runDir, { checkId: check.id, kind: "security", ran: true, classification: "confirmed", assertion: check.description, observation: finding.actual, evidenceRefs: evidenceFilenames.map((f) => `findings/${findingId}/${f}`), findingId }, extraSecrets);
}

function blockedEntry(check: DeclaredSecurityCheck, reason: string): CheckLedgerEntry {
  return { checkId: check.id, kind: "security", ran: false, blockedReason: reason, classification: "unsupported", assertion: check.description, observation: "Not run.", evidenceRefs: [] };
}
