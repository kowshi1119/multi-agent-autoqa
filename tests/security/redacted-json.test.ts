import { expect, it } from "vitest";
import { redactSecrets } from "../../src/redact.js";

it("keeps token-bearing authentication URLs parseable when redacting serialized evidence", () => {
  const record = { status: "success", authenticatedUrl: "https://example.invalid/home?token=fake-callback&tab=overview", checks: { passed: true }, actions: 4 };
  const redacted = redactSecrets(JSON.stringify(record, null, 2));
  expect(redacted).not.toContain("fake-callback");
  expect(JSON.parse(redacted)).toEqual({ ...record, authenticatedUrl: "https://example.invalid/home?token=<REDACTED>&tab=overview" });
});

it("preserves escaped quotes and adjacent JSON values in redacted strings", () => {
  const redacted = redactSecrets(JSON.stringify({ notes: 'token=synthetic"quoted"', rest: ["safe"] }));
  expect(redacted).not.toContain("synthetic");
  expect(JSON.parse(redacted)).toEqual({ notes: 'token=<REDACTED>"quoted"', rest: ["safe"] });
});

// 2026-09-23 widening (API/security-check evidence can surface plain
// key=value/key: value text -- e.g. a flattened response-header line or a
// query string -- using key names the old exact-word-only pattern missed).
it("redacts camelCase/snake_case/hyphenated key names that merely contain a core keyword as a substring", () => {
  const redacted = redactSecrets("sessionToken=abc123 api_key=def456 X-Auth-Token: ghi789 apiSecret=jkl000");
  expect(redacted).not.toContain("abc123");
  expect(redacted).not.toContain("def456");
  expect(redacted).not.toContain("ghi789");
  expect(redacted).not.toContain("jkl000");
  expect(redacted).toBe("sessionToken=<REDACTED> api_key=<REDACTED> X-Auth-Token=<REDACTED> apiSecret=<REDACTED>");
});

it("redacts a plain-text cookie/set-cookie header line", () => {
  const redacted = redactSecrets("Cookie: sessionid=abc999; Set-Cookie: sessionid=abc999");
  expect(redacted).not.toContain("abc999");
});

it("still leaves unrelated key names untouched (no over-broad matching of every '=' pair)", () => {
  const redacted = redactSecrets(JSON.stringify({ status: "ok", actions: 4, checks: { passed: true } }));
  expect(JSON.parse(redacted)).toEqual({ status: "ok", actions: 4, checks: { passed: true } });
});
