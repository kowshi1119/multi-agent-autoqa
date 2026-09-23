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
