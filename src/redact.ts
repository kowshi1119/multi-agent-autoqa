const PLACEHOLDER = "<QA_PASSWORD>";
const SECRET_PLACEHOLDER = "<REDACTED>";
const CREDENTIAL_PLACEHOLDER = "<REDACTED_CREDENTIAL>";

/**
 * Strips known secret values out of any text destined for logs, prompts,
 * evidence, or reports. Env-derived values are read fresh from process.env
 * each call (never cached) so a secret is never held longer than necessary.
 *
 * `extraSecrets` covers transient, per-run credentials that never touch
 * process.env at all -- e.g. a username/password submitted through the
 * local UI's login form and passed straight through as a request-scoped
 * value (see credentialSecrets() below and its callers). Forcing such a
 * value into process.env just to reuse the env-based path would leak it
 * far beyond this one run, so it is threaded through explicitly instead.
 */
export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let result = text;

  const password = process.env["QA_PASSWORD"];
  if (password) {
    result = result.split(password).join(PLACEHOLDER);
  }

  const otherSecrets = [
    process.env["ANTHROPIC_API_KEY"],
    process.env["OPENAI_API_KEY"],
    process.env["GEMINI_API_KEY"],
    process.env["EXPLABS_API_KEY"],
    process.env["EXPLABS_EXPLORER_API_KEY"],
    process.env["EXPLABS_CRITIC_API_KEY"],
  ];

  for (const secret of otherSecrets) {
    if (secret) {
      result = result.split(secret).join(SECRET_PLACEHOLDER);
    }
  }

  for (const secret of extraSecrets) {
    if (secret) {
      result = result.split(secret).join(CREDENTIAL_PLACEHOLDER);
    }
  }

  return result
    .replace(/\b(?:xpl_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]{35})\b/g, SECRET_PLACEHOLDER)
    // Keep delimiters intact when redacting an already-serialized JSON
    // string (e.g. a landing URL with ?token=... immediately before its
    // closing quote). Consuming that quote made run evidence unparseable.
    .replace(/\b(authorization|token|password|secret)\s*[=:]\s*(?:bearer\s+)?[^\\\s,;"'<>}\]&]+/gi, "$1=<REDACTED>");
}

/**
 * Extracts the literal values worth scrubbing from a transient run-scoped
 * credential pair (see TransientCredentials in src/auth/session-bootstrap.ts)
 * without importing that module here (would create a cycle: auth ->
 * actions -> redact). Never persisted, never written to process.env --
 * held only as long as the caller's own local variable lives.
 */
export function credentialSecrets(credentials?: { username?: string; password?: string }): string[] {
  if (!credentials) return [];
  return [credentials.username, credentials.password].filter((v): v is string => Boolean(v));
}
