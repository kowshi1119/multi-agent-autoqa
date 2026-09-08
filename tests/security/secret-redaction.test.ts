import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCriticArtifact } from "../../src/evidence.js";
import { redactSecrets } from "../../src/redact.js";

const fakeCredential = "test_key_DO_NOT_USE_12345";
const originalCredential = process.env.EXPLABS_API_KEY;

afterEach(() => {
  if (originalCredential === undefined) delete process.env.EXPLABS_API_KEY;
  else process.env.EXPLABS_API_KEY = originalCredential;
});

describe("secret redaction", () => {
  it("redacts experimental credentials and authorization values", () => {
    process.env.EXPLABS_API_KEY = fakeCredential;
    const output = redactSecrets(`credential=${fakeCredential} Authorization: Bearer ${fakeCredential}`);

    expect(output).not.toContain(fakeCredential);
    expect(output).toContain("<REDACTED>");
  });

  it("does not persist an environment credential in critic evidence", () => {
    process.env.EXPLABS_API_KEY = fakeCredential;
    const evidenceDir = mkdtempSync(join(tmpdir(), "autoqa-redaction-test-"));
    const filename = writeCriticArtifact(evidenceDir, {
      provider: "explabs",
      verdict: "needs_human",
      confidence: 0,
      summary: fakeCredential,
      evidenceReferences: [],
      missingEvidence: [],
    });
    const saved = readFileSync(join(evidenceDir, filename), "utf-8");

    expect(saved).not.toContain(fakeCredential);
    expect(saved).toContain("<REDACTED>");
  });
});