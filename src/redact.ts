const PLACEHOLDER = "<QA_PASSWORD>";
const SECRET_PLACEHOLDER = "<REDACTED>";

/**
 * Strips known secret values out of any text destined for logs, prompts,
 * evidence, or reports. Values are read fresh from process.env each call
 * (never cached) so a secret is never held longer than necessary.
 */
export function redactSecrets(text: string): string {
  let result = text;

  const password = process.env["QA_PASSWORD"];
  if (password) {
    result = result.split(password).join(PLACEHOLDER);
  }

  const otherSecrets = [
    process.env["ANTHROPIC_API_KEY"],
    process.env["OPENAI_API_KEY"],
    process.env["EXPLABS_API_KEY"],
    process.env["EXPLABS_EXPLORER_API_KEY"],
    process.env["EXPLABS_CRITIC_API_KEY"],
  ];

  for (const secret of otherSecrets) {
    if (secret) {
      result = result.split(secret).join(SECRET_PLACEHOLDER);
    }
  }

  return result
    .replace(/\b(?:xpl_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+)\b/g, SECRET_PLACEHOLDER)
    .replace(/\b(authorization|token|password|secret)\s*[=:]\s*(?:bearer\s+)?[^\s,;]+/gi, "$1=<REDACTED>");
}
