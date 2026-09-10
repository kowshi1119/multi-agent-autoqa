import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCriticArtifact } from "../../src/evidence.js";
import { redactSecrets } from "../../src/redact.js";
import { captureManifest } from "../../src/experiments/manifest.js";
import { exportForBlindReview } from "../../src/human-review/export.js";
import { loadTestConfig } from "../helpers/test-config.js";
import type { Finding } from "../../src/types.js";

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

  it("Phase 3 experiment manifest artifacts are redacted before persisting (same writeJsonRedacted idiom as evidence.ts)", () => {
    process.env.EXPLABS_API_KEY = fakeCredential;
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-redaction-manifest-test-"));
    mkdirSync(join(runDir, "findings", "FINDING-001"), { recursive: true });
    writeFileSync(join(runDir, "findings", "FINDING-001", "oracle.json"), "{}", "utf-8");

    const manifest = captureManifest({
      experimentId: "EXPERIMENT3-TEST",
      config: loadTestConfig(),
      runId: "RUN-TEST",
      runDir,
      findingIds: ["FINDING-001"],
      explorerProviderName: "mock",
      // A stray field that, if ever mistakenly populated from an env var
      // upstream, must still never survive to disk unredacted.
      explorerModel: fakeCredential,
    });

    const serialized = redactSecrets(JSON.stringify(manifest, null, 2));
    expect(serialized).not.toContain(fakeCredential);
    expect(serialized).toContain("<REDACTED>");
  });

  it("human-review blind export artifacts are redacted before persisting", () => {
    process.env.EXPLABS_API_KEY = fakeCredential;
    const leaky: Finding = {
      id: "FINDING-001",
      title: `New browser console error appears after form submission: ${fakeCredential}`,
      status: "validated",
      category: "console",
      pageId: "PAGE-001",
      url: "http://localhost:4173/form",
      pathname: "/form",
      expected: "e",
      actual: "a",
      oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a" },
      steps: [],
      reproduction: { attempts: 3, successes: 3 },
      occurrenceCount: 1,
      evidence: [],
      evidenceLevel: "L3",
      reportDisposition: "report",
    };

    const { export: blindExport } = exportForBlindReview([leaky]);
    const serialized = redactSecrets(JSON.stringify(blindExport, null, 2));
    expect(serialized).not.toContain(fakeCredential);
    expect(serialized).toContain("<REDACTED>");
  });
});