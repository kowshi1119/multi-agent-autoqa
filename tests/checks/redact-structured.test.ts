import { expect, it } from "vitest";
import { redactStructuredEvidence } from "../../src/checks/redact-structured.js";
import { redactSecrets } from "../../src/redact.js";

it("redacts a nested Set-Cookie/Authorization header object by key name, regardless of value shape", () => {
  const headers = {
    "content-type": "application/json",
    "Set-Cookie": "sessionid=abc123; Path=/; HttpOnly",
    Authorization: "Bearer super-secret-token-xyz",
  };
  const redacted = redactStructuredEvidence(headers) as Record<string, unknown>;

  expect(redacted["content-type"]).toBe("application/json");
  expect(redacted["Set-Cookie"]).toBe("<REDACTED>");
  expect(redacted["Authorization"]).toBe("<REDACTED>");
});

it("proves the gap this closes: a flat redactSecrets() pass over the same JSON-serialized object does NOT catch a quoted 'Set-Cookie' key", () => {
  const headers = { "Set-Cookie": "sessionid=abc123; Path=/" };
  const flatPass = redactSecrets(JSON.stringify(headers));
  // The key-name group can't reach the colon through the JSON key's own
  // closing quote, so the cookie value survives a flat pass untouched --
  // this is exactly why redactStructuredEvidence exists as a separate step.
  expect(flatPass).toContain("abc123");
});

it("redacts sensitive keys arbitrarily deep in nested objects and arrays", () => {
  const evidence = {
    request: { url: "https://example.invalid/api/users/1", headers: { cookie: "sid=deep-secret-1" } },
    response: {
      status: 200,
      headers: [{ name: "set-cookie", value: "sid=deep-secret-2" }],
      body: { user: { id: 1, apiToken: "deep-secret-3" } },
    },
  };
  const redacted = JSON.stringify(redactStructuredEvidence(evidence));

  expect(redacted).not.toContain("deep-secret-1");
  expect(redacted).not.toContain("deep-secret-3");
  // The array-of-objects header shape ({name, value}) doesn't expose the
  // header name AS a key -- "value" itself isn't sensitive-named, so this
  // documents the current boundary rather than asserting a false guarantee.
  expect(redacted).toContain("deep-secret-2");
});

it("leaves non-sensitive structure and values completely unchanged", () => {
  const evidence = { checkId: "API-001", status: 200, contentType: "application/json", ok: true, count: 3 };
  expect(redactStructuredEvidence(evidence)).toEqual(evidence);
});

it("still applies pattern-based redaction (bearer tokens, extraSecrets) on every string leaf, not just key-matched ones", () => {
  const evidence = { notes: "used credential my-transient-pw twice", unrelatedField: "Authorization: Bearer some-token-value" };
  const redacted = redactStructuredEvidence(evidence, ["my-transient-pw"]) as Record<string, unknown>;

  expect(redacted.notes).not.toContain("my-transient-pw");
  expect(JSON.stringify(redacted.unrelatedField)).not.toContain("some-token-value");
});
