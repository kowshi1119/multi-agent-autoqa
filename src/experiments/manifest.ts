import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";

export type ExperimentManifestSchemaVersion = 1;

export type ExperimentManifest = {
  schemaVersion: ExperimentManifestSchemaVersion;
  experimentId: string;
  createdAt: string;
  /** null when `git rev-parse HEAD` is unavailable (not a git repo, git missing) -- never fabricated. */
  commit: string | null;
  /** The exact AppConfig used to capture, JSON-round-tripped. Already credential-free by config.ts's own inline-credential rejection invariant -- re-verified nowhere else needed. */
  sanitizedConfig: AppConfig;
  requirementsVersion: { path: string; sha256: string } | null;
  datasetIdentity: { source: "local-fixture"; runId: string; runDir: string };
  /** One entry per captured finding; sha256 per evidence file lets replay detect any tampering or drift. */
  findingsSnapshot: Array<{ findingId: string; evidenceDir: string; evidenceHashes: Record<string, string> }>;
  budgets: { maxCriticCalls: number; providerTimeoutMs: number };
  resolvedProviders: { explorer: { name: string; model?: string } };
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashEvidenceDir(evidenceDir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const name of readdirSync(evidenceDir)) {
    const path = join(evidenceDir, name);
    if (statSync(path).isFile()) hashes[name] = sha256File(path);
  }
  return hashes;
}

function currentCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function sha256IfExists(path: string): string | null {
  try {
    return sha256File(path);
  } catch {
    return null;
  }
}

export function captureManifest(input: {
  experimentId: string;
  config: AppConfig;
  runId: string;
  runDir: string;
  findingIds: string[];
  explorerProviderName: string;
  explorerModel?: string;
}): ExperimentManifest {
  const requirementsHash = input.config.requirements.enabled ? sha256IfExists(input.config.requirements.path) : null;

  return {
    schemaVersion: 1,
    experimentId: input.experimentId,
    createdAt: new Date().toISOString(),
    commit: currentCommit(),
    sanitizedConfig: input.config,
    requirementsVersion: requirementsHash ? { path: input.config.requirements.path, sha256: requirementsHash } : null,
    datasetIdentity: { source: "local-fixture", runId: input.runId, runDir: input.runDir },
    findingsSnapshot: input.findingIds.map((findingId) => {
      const evidenceDir = join(input.runDir, "findings", findingId);
      return { findingId, evidenceDir, evidenceHashes: hashEvidenceDir(evidenceDir) };
    }),
    budgets: { maxCriticCalls: input.config.agent.maxCriticCalls, providerTimeoutMs: input.config.models.providerTimeoutMs },
    resolvedProviders: {
      explorer: { name: input.explorerProviderName, ...(input.explorerModel ? { model: input.explorerModel } : {}) },
    },
  };
}

export type IntegrityCheckResult = {
  valid: boolean;
  mismatches: Array<{ findingId: string; file: string; reason: "missing" | "hash-mismatch" }>;
};

/** Recomputes every evidence file's hash and compares against the manifest -- never reopens the browser, purely a filesystem check. */
export function verifyManifestIntegrity(manifest: ExperimentManifest): IntegrityCheckResult {
  const mismatches: IntegrityCheckResult["mismatches"] = [];

  for (const snapshot of manifest.findingsSnapshot) {
    for (const [file, expectedHash] of Object.entries(snapshot.evidenceHashes)) {
      const path = join(snapshot.evidenceDir, file);
      const actualHash = sha256IfExists(path);
      if (actualHash === null) {
        mismatches.push({ findingId: snapshot.findingId, file, reason: "missing" });
      } else if (actualHash !== expectedHash) {
        mismatches.push({ findingId: snapshot.findingId, file, reason: "hash-mismatch" });
      }
    }
  }

  return { valid: mismatches.length === 0, mismatches };
}
