import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { FIXTURE_ORACLE_CONFIG } from "../src/fixture-oracle-config.js";
import { parseProfile } from "../src/profiles/schema.js";
import { profileToAppConfig } from "../src/profiles/to-app-config.js";

describe("fixture oracle-config parity (Phase 4 continuation, §5)", () => {
  it("qa.config.mock.yaml's own oracle section deep-equals FIXTURE_ORACLE_CONFIG -- update both together if this ever changes", () => {
    const config = loadConfig(resolve("qa.config.mock.yaml"));
    expect(config.oracles).toEqual(FIXTURE_ORACLE_CONFIG);
  });

  it("a fixture-profile-derived AppConfig carries the same oracle rules/patterns as the CLI mock config (UI/CLI parity)", () => {
    const profile = parseProfile({
      schemaVersion: 1,
      id: "fixture",
      name: "Fixture",
      target: { url: "http://localhost:4173/", environmentKind: "local-fixture" },
      navigation: { allowedOrigins: ["http://localhost:4173"], allowedPathPrefixes: [] },
      resources: { allowedApiOrigins: [], allowedFormSubmitEndpoints: [] },
      workflows: { allowedWorkflowKinds: [] },
      auth: { mode: "none" },
      provider: {
        explorer: { provider: "mock" },
        critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
        providerTimeoutMs: 30000,
      },
      limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
    });

    const config = profileToAppConfig(profile);
    const cliConfig = loadConfig(resolve("qa.config.mock.yaml"));

    expect(config.oracles).toEqual(cliConfig.oracles);
  });

  it("a real-target profile keeps conservative empty oracle defaults (nothing to seed rules/patterns from)", () => {
    const profile = parseProfile({
      schemaVersion: 1,
      id: "real-target",
      name: "Real Target",
      target: { url: "https://example.test/", environmentKind: "self-hosted-real-app" },
      navigation: { allowedOrigins: ["https://example.test"], allowedPathPrefixes: [] },
      resources: { allowedApiOrigins: [], allowedFormSubmitEndpoints: [] },
      workflows: { allowedWorkflowKinds: [] },
      auth: { mode: "none" },
      provider: {
        explorer: { provider: "mock" },
        critic: { enabled: false, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
        providerTimeoutMs: 30000,
      },
      limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
    });

    const config = profileToAppConfig(profile);
    expect(config.oracles.uiApiConsistency.rules).toEqual([]);
    expect(config.oracles.duplicateRequest.patterns).toEqual([]);
  });
});
