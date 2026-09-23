import { redactSecrets } from "../redact.js";

/**
 * redactSecrets() (src/redact.ts) is a flat regex over already-serialized
 * text -- it matches a "key=value"/"key: value" *shape* directly in the
 * string, which a JSON-quoted key like {"Set-Cookie": "sessionid=..."}
 * doesn't present (there's a stray closing-quote character between the key
 * and its delimiter, so the regex's key-name group never reaches the
 * colon). That's fine for URLs and flattened log lines, but the new
 * API/security check runners capture real response headers and cookies as
 * structured objects before anything is serialized -- this walks that
 * structure by KEY NAME, independent of how deeply it's nested or how the
 * value is shaped, and is the mechanism that actually redacts a header
 * object like { "Set-Cookie": "sessionid=abc; Path=/" } correctly.
 *
 * Every string leaf (whether or not its key matched) is still passed
 * through redactSecrets() afterward for pattern-based catches (bearer
 * tokens, known API-key shapes, env-sourced secrets) -- this function adds
 * structural key-based redaction on top of that, it doesn't replace it.
 */
const SENSITIVE_KEY_RE = /(?:authorization|token|password|secret|cookie|api[_-]?key)/i;
const REDACTED_VALUE = "<REDACTED>";

export function redactStructuredEvidence(value: unknown, extraSecrets: readonly string[] = []): unknown {
  return walk(value, extraSecrets);
}

function walk(value: unknown, extraSecrets: readonly string[], depth = 0): unknown {
  if (depth > 30) return "<OMITTED_DEPTH_LIMIT>";
  if (typeof value === "string") {
    if (/^\s*[\[{]/.test(value)) {
      try { return JSON.stringify(walk(JSON.parse(value), extraSecrets, depth + 1)); } catch { /* plain text */ }
    }
    return redactSecrets(value, extraSecrets);
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, extraSecrets, depth + 1));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const namedHeader = value as { name?: unknown };
    const sensitiveHeader = typeof namedHeader.name === "string" && SENSITIVE_KEY_RE.test(namedHeader.name);
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key) || (sensitiveHeader && key === "value")) {
        result[redactSecrets(key, extraSecrets)] = REDACTED_VALUE;
      } else {
        result[redactSecrets(key, extraSecrets)] = walk(v, extraSecrets, depth + 1);
      }
    }
    return result;
  }
  return value;
}
