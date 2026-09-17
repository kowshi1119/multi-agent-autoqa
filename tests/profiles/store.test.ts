import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileStore } from "../../src/profiles/store.js";
import { parseProfile, type ProjectProfile } from "../../src/profiles/schema.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "autoqa-profile-store-test-"));
}

function validProfile(id: string): ProjectProfile {
  return parseProfile({
    schemaVersion: 1,
    id,
    name: `Test ${id}`,
    target: { url: "http://localhost:9999/", environmentKind: "local-fixture" },
    navigation: { allowedOrigins: ["http://localhost:9999"], allowedPathPrefixes: ["/"] },
    resources: { allowedApiOrigins: ["http://localhost:9999"], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"] },
    auth: { mode: "none" },
    provider: {
      explorer: { provider: "mock" },
      critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
      providerTimeoutMs: 30000,
    },
    limits: { maxActions: 40, maxModelCalls: 20, maxPages: 5, maxFindings: 10, maxDurationMs: 300000, maxCriticCalls: 6 },
  });
}

describe("ProfileStore.list() (2026-09-15 fix: a sibling <id>.workflows.json manifest must not break profile listing)", () => {
  it("lists saved profiles normally", () => {
    const dir = tempDir();
    const store = new ProfileStore(dir);
    store.save(validProfile("p1"));
    store.save(validProfile("p2"));

    const ids = store.list().map((p) => p.id).sort();

    expect(ids).toEqual(["p1", "p2"]);
  });

  it("a declared-workflow manifest file (<id>.workflows.json, a different shape entirely -- see src/pilot/workflow-manifest.ts) sitting alongside profiles does not break list() -- this reproduces a real bug found via browser verification: GET /api/profiles 500'd once profiles/orangehrm.workflows.json existed", () => {
    const dir = tempDir();
    const store = new ProfileStore(dir);
    store.save(validProfile("orangehrm"));
    // Same shape as the real profiles/orangehrm.workflows.json: workflows is an
    // array, not the {allowedWorkflowKinds:[...]} object a real profile requires.
    writeFileSync(
      join(dir, "orangehrm.workflows.json"),
      JSON.stringify({ schemaVersion: 1, profileId: "orangehrm", pages: [], workflows: [] }, null, 2),
      "utf-8"
    );

    const ids = store.list().map((p) => p.id);

    expect(ids).toEqual(["orangehrm"]);
  });
});
