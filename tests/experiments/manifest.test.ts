import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureManifest, verifyManifestIntegrity } from "../../src/experiments/manifest.js";
import { loadTestConfig } from "../helpers/test-config.js";

function tempRunDir(findingIds: string[]): string {
  const runDir = mkdtempSync(join(tmpdir(), "autoqa-manifest-test-"));
  for (const id of findingIds) {
    const dir = join(runDir, "findings", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "oracle.json"), JSON.stringify({ oracleId: "console-error" }), "utf-8");
    writeFileSync(join(dir, "finding.json"), JSON.stringify({ id }), "utf-8");
  }
  return runDir;
}

describe("captureManifest / verifyManifestIntegrity", () => {
  it("captures a hash per evidence file and verifies clean on an untouched run", () => {
    const runDir = tempRunDir(["FINDING-001"]);
    const manifest = captureManifest({
      experimentId: "EXPERIMENT3-TEST",
      config: loadTestConfig(),
      runId: "RUN-TEST",
      runDir,
      findingIds: ["FINDING-001"],
      explorerProviderName: "mock",
    });

    expect(manifest.findingsSnapshot).toHaveLength(1);
    expect(Object.keys(manifest.findingsSnapshot[0]?.evidenceHashes ?? {}).sort()).toEqual(["finding.json", "oracle.json"]);

    const result = verifyManifestIntegrity(manifest);
    expect(result.valid).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it("reports a specific hash-mismatch, not a generic failure, when an evidence file is altered after capture", () => {
    const runDir = tempRunDir(["FINDING-001"]);
    const manifest = captureManifest({
      experimentId: "EXPERIMENT3-TEST",
      config: loadTestConfig(),
      runId: "RUN-TEST",
      runDir,
      findingIds: ["FINDING-001"],
      explorerProviderName: "mock",
    });

    writeFileSync(join(runDir, "findings", "FINDING-001", "oracle.json"), JSON.stringify({ oracleId: "tampered" }), "utf-8");

    const result = verifyManifestIntegrity(manifest);
    expect(result.valid).toBe(false);
    expect(result.mismatches).toEqual([{ findingId: "FINDING-001", file: "oracle.json", reason: "hash-mismatch" }]);
  });

  it("reports 'missing' when an evidence file capture referenced no longer exists", () => {
    const runDir = tempRunDir(["FINDING-001"]);
    const manifest = captureManifest({
      experimentId: "EXPERIMENT3-TEST",
      config: loadTestConfig(),
      runId: "RUN-TEST",
      runDir,
      findingIds: ["FINDING-001"],
      explorerProviderName: "mock",
    });

    // Simulate deletion by pointing at a path that no longer has the file.
    const corrupted = { ...manifest, findingsSnapshot: [{ ...manifest.findingsSnapshot[0]!, evidenceDir: join(runDir, "findings", "DOES-NOT-EXIST") }] };
    const result = verifyManifestIntegrity(corrupted);
    expect(result.valid).toBe(false);
    expect(result.mismatches.every((m) => m.reason === "missing")).toBe(true);
  });

  it("sanitizedConfig never contains a credential -- config.ts's inline-credential rejection already guarantees this, re-verified here", () => {
    const runDir = tempRunDir(["FINDING-001"]);
    const manifest = captureManifest({
      experimentId: "EXPERIMENT3-TEST",
      config: loadTestConfig(),
      runId: "RUN-TEST",
      runDir,
      findingIds: ["FINDING-001"],
      explorerProviderName: "mock",
    });
    const serialized = JSON.stringify(manifest.sanitizedConfig).toLowerCase();
    expect(serialized).not.toContain("apikey");
    expect(serialized).not.toContain("api_key");
  });
});
