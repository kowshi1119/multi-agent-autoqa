import type { AssertionOutcome } from "../outcomes/outcome.js";

/**
 * Per-assertion security policy evaluation. Each assertion is a *declared
 * policy* check: a failure means the response did not meet the stated
 * policy, not that an exploitable vulnerability was demonstrated. Several
 * failing assertions on one check still produce one finding (one underlying
 * response), never several independent vulnerabilities.
 *
 * Sources (accessed 2026-09-29):
 *  - RFC 6797 §7.2/§8.1: an HSTS host must not send Strict-Transport-Security
 *    over non-secure transport and user agents must ignore it there, so the
 *    HSTS assertion is "not assessed" on http:// origins.
 *  - MDN Set-Cookie: insecure (http:) sites cannot set Secure cookies, except
 *    localhost; so the Secure attribute is "not assessed" on non-localhost
 *    http:// origins.
 */
export type SecurityAssessment = { assertions: AssertionOutcome[] };

const POLICY_LIMITATION = "A declared policy assertion: failing it shows the policy was not met on this response, not that a vulnerability is exploitable.";
const HEADER_RATIONALE = "Defense-in-depth policy gap on one response; no exploit demonstrated. Rated low (policy) unless other evidence shows impact.";

type Context = { origin: string };
const isHttps = (origin: string): boolean => origin.startsWith("https:");
const isLocalhost = (origin: string): boolean => { try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname); } catch { return false; } };
const clip = (value: string): string => value.length > 120 ? `${value.slice(0, 120)}…` : value;

export const SECURITY_HEADERS = ["content-security-policy", "x-content-type-options", "x-frame-options", "strict-transport-security"] as const;

export function assessSecurityHeaders(headers: Record<string, string>, context: Context): SecurityAssessment {
  return {
    assertions: SECURITY_HEADERS.map((header): AssertionOutcome => {
      const id = `header:${header}`;
      if (header === "strict-transport-security" && !isHttps(context.origin)) {
        return { id, assertion: `Response carries ${header}`, expected: "present (HTTPS only)", observed: "not applicable over http://", verdict: "not-assessed", reasonCode: "not-applicable", confidence: "high", limitations: "RFC 6797 §7.2/§8.1: HSTS is not sent or honoured over non-secure transport; assess on the HTTPS deployment." };
      }
      const value = headers[header];
      return value !== undefined
        ? { id, assertion: `Response carries ${header}`, expected: "present", observed: `present (${clip(value)})`, verdict: "pass", reasonCode: "ok", confidence: "high", limitations: POLICY_LIMITATION }
        : { id, assertion: `Response carries ${header}`, expected: "present", observed: "absent", verdict: "fail", reasonCode: "assertion-failed", confidence: "high", limitations: POLICY_LIMITATION, severityRationale: HEADER_RATIONALE };
    }),
  };
}

const COOKIE_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function assessCookieAttributes(setCookies: string[], context: Context): SecurityAssessment {
  if (!setCookies.length) {
    return { assertions: [{ id: "cookie:any:present", assertion: "Session cookies carry HttpOnly, Secure and SameSite", expected: "Set-Cookie to inspect", observed: "no Set-Cookie header on this response", verdict: "not-assessed", reasonCode: "not-applicable", confidence: "high", limitations: "Nothing to inspect on this response; cookie policy is not assessed." }] };
  }
  const assertions: AssertionOutcome[] = [];
  setCookies.forEach((cookie, index) => {
    const rawName = cookie.split("=")[0]?.trim() ?? "";
    // The cookie name only (never its value); unusual names are replaced by a position.
    const name = COOKIE_NAME_RE.test(rawName) ? rawName : `cookie-${index + 1}`;
    const attrs = new Map(cookie.split(";").slice(1).map((part) => { const [key, ...value] = part.trim().split("="); return [(key ?? "").toLowerCase(), value.join("=").toLowerCase()]; }));
    for (const attr of ["httponly", "secure", "samesite"] as const) {
      const id = `cookie:${name}:${attr}`;
      const label = `Cookie ${name} carries ${attr === "httponly" ? "HttpOnly" : attr === "secure" ? "Secure" : "SameSite"}`;
      if (attr === "secure" && !isHttps(context.origin) && !isLocalhost(context.origin)) {
        assertions.push({ id, assertion: label, expected: "Secure", observed: "not applicable over http://", verdict: "not-assessed", reasonCode: "not-applicable", confidence: "high", limitations: "Insecure (http:) sites cannot set Secure cookies (MDN Set-Cookie); assess on the HTTPS deployment." });
        continue;
      }
      const ok = attr === "samesite" ? ["strict", "lax", "none"].includes(attrs.get("samesite") ?? "") : attrs.has(attr);
      assertions.push(ok
        ? { id, assertion: label, expected: "present", observed: attr === "samesite" ? `SameSite=${attrs.get("samesite")}` : "present", verdict: "pass", reasonCode: "ok", confidence: "high", limitations: POLICY_LIMITATION }
        : { id, assertion: label, expected: "present", observed: "absent", verdict: "fail", reasonCode: "assertion-failed", confidence: "high", limitations: POLICY_LIMITATION,
            severityRationale: `Missing ${attr} increases exposure to ${attr === "httponly" ? "script-based cookie theft (XSS)" : attr === "samesite" ? "cross-site request forgery" : "transport downgrade"} but does not prove an exploitable vulnerability; context matters.` });
    }
  });
  return { assertions };
}

export function assessSecretLeakage(body: unknown, structuralMatch: { path: string } | undefined, keyShaped: boolean, keyValueText: boolean): SecurityAssessment {
  const limitation = "Pattern-based: can miss secrets without a recognisable shape and cannot establish whether a disclosure was intended.";
  const rationale = "A credential-shaped value in a response could allow impersonation if captured; exposure context requires review.";
  const sensitive: AssertionOutcome = structuralMatch || keyValueText
    ? { id: "secret:sensitive-field", assertion: "No credential- or token-named field in the response", expected: "none", observed: structuralMatch ? `field "${structuralMatch.path}" holds a credential/token-shaped value (value omitted)` : "a key=value credential shape (value omitted)", verdict: "fail", reasonCode: "assertion-failed", confidence: "medium", limitations: limitation, severityRationale: rationale }
    : { id: "secret:sensitive-field", assertion: "No credential- or token-named field in the response", expected: "none", observed: "none found", verdict: "pass", reasonCode: "ok", confidence: "medium", limitations: limitation };
  const shaped: AssertionOutcome = keyShaped
    ? { id: "secret:key-shaped-value", assertion: "No provider-key-shaped value in the response", expected: "none", observed: "a key-shaped value (omitted)", verdict: "fail", reasonCode: "assertion-failed", confidence: "medium", limitations: limitation, severityRationale: rationale }
    : { id: "secret:key-shaped-value", assertion: "No provider-key-shaped value in the response", expected: "none", observed: "none found", verdict: "pass", reasonCode: "ok", confidence: "medium", limitations: limitation };
  void body;
  return { assertions: [sensitive, shaped] };
}

/** An error or redirect response cannot establish any of the policy assertions. */
export function notInspected(ids: string[], status: number): SecurityAssessment {
  return { assertions: ids.map((id) => ({ id, assertion: id, expected: "inspect a successful response", observed: `HTTP ${status}; resource not successfully inspected`, verdict: "not-assessed" as const, reasonCode: "precondition-failed" as const, confidence: "high" as const, limitations: "Error and redirect responses cannot establish a security policy result." })) };
}
