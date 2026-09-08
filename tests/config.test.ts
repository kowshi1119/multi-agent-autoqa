import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const validYaml = `
project:
  name: "AutoQA Demo"
target:
  url: "http://localhost:4173/"
  environment: "local-fixture"
browser:
  engine: "chromium"
  headless: true
  viewport:
    width: 1440
    height: 900
agent:
  maxActions: 15
  maxModelCalls: 15
  maxPages: 10
  maxFindings: 10
  maxDurationMs: 300000
  maxCriticCalls: 10
heuristics:
  longTextBoundaryChars: 500
  safeControlClick:
    enabled: true
    allowedControls: []
validation:
  attempts: 3
  minimumSuccesses: 2
oracles:
  uiApiConsistency:
    enabled: true
    rules: []
  console:
    enabled: true
    ignorePatterns: []
  pageError:
    enabled: true
  httpFailure:
    enabled: true
  duplicateRequest:
    enabled: true
    patterns:
      - method: "POST"
        pathname: "/api/submit"
        expectedMax: 1
evidence:
  screenshots: true
  trace: true
  console: true
  network: true
models:
  explorer:
    provider: "auto"
  critic:
    enabled: false
    provider: "mock"
    requireIndependentProvider: false
    maxCallsPerFinding: 1
  providerTimeoutMs: 30000
safety:
  safeMode: true
  allowedOrigins:
    - "http://localhost:4173"
`;

function writeConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "autoqa-config-test-"));
  const path = join(dir, "qa.config.yaml");
  writeFileSync(path, yaml, "utf-8");
  return path;
}

describe("loadConfig", () => {
  it("accepts a valid configuration", () => {
    const path = writeConfig(validYaml);
    const config = loadConfig(path);
    expect(config.project.name).toBe("AutoQA Demo");
    expect(config.target.url).toBe("http://localhost:4173/");
    expect(config.validation.attempts).toBe(3);
  });

  it("rejects an invalid target.url", () => {
    const invalid = validYaml.replace(
      'url: "http://localhost:4173/"',
      'url: "not-a-url"'
    );
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
    expect(() => loadConfig(path)).toThrow(/target.url/);
  });

  it("rejects minimumSuccesses greater than attempts", () => {
    const invalid = validYaml
      .replace("attempts: 3", "attempts: 2")
      .replace("minimumSuccesses: 2", "minimumSuccesses: 3");
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
    expect(() => loadConfig(path)).toThrow(/minimumSuccesses/);
  });

  it("rejects a non-positive maxActions", () => {
    const invalid = validYaml.replace("maxActions: 15", "maxActions: 0");
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it("rejects an invalid allowed origin", () => {
    const invalid = validYaml.replace(
      '- "http://localhost:4173"',
      '- "not an origin"'
    );
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it("rejects longTextBoundaryChars above the attack-scale guard rail", () => {
    const invalid = validYaml.replace(
      "longTextBoundaryChars: 500",
      "longTextBoundaryChars: 1000000"
    );
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it("rejects a non-positive longTextBoundaryChars", () => {
    const invalid = validYaml.replace("longTextBoundaryChars: 500", "longTextBoundaryChars: 0");
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it("rejects a duplicateRequest pattern with expectedMax below 1", () => {
    const invalid = validYaml.replace("expectedMax: 1", "expectedMax: 0");
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it("rejects a duplicateRequest pattern whose pathname does not start with /", () => {
    const invalid = validYaml.replace('pathname: "/api/submit"', 'pathname: "api/submit"');
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it("rejects a non-positive maxPages", () => {
    const invalid = validYaml.replace("maxPages: 10", "maxPages: 0");
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it("rejects a non-positive maxFindings", () => {
    const invalid = validYaml.replace("maxFindings: 10", "maxFindings: 0");
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it("rejects a non-positive maxDurationMs", () => {
    const invalid = validYaml.replace("maxDurationMs: 300000", "maxDurationMs: 0");
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it("rejects models.provider anthropic without a model configured", () => {
    const invalid = validYaml
      .replace('provider: "auto"', 'provider: "anthropic"');
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it("accepts models.provider mock without a model configured", () => {
    const withMock = validYaml
      .replace('provider: "auto"', 'provider: "mock"');
    const path = writeConfig(withMock);
    expect(() => loadConfig(path)).not.toThrow();
  });

  it("rejects inline credentials", () => {
    const path = writeConfig(`${validYaml}\ncredentials:\n  apiKey: "test_key_DO_NOT_USE_12345"\n`);
    expect(() => loadConfig(path)).toThrow(/inline credential/);
  });

  it("rejects requireIndependentProvider:true when explorer and critic both use the explabs provider, even with role-scoped credentials", () => {
    const invalid = validYaml
      .replace('provider: "auto"', 'provider: "explabs"\n    model: "qwen3.8-27b"')
      .replace("enabled: false", "enabled: true")
      .replace('provider: "mock"\n    requireIndependentProvider: false', 'provider: "explabs"\n    model: "qwen3.8-27b"\n    requireIndependentProvider: true');
    const path = writeConfig(invalid);
    expect(() => loadConfig(path)).toThrow(ConfigError);
    expect(() => loadConfig(path)).toThrow(/MODEL_ROLE_CONFIGURATION_ERROR/);
  });

  it("accepts requireIndependentProvider:true when explorer and critic use different providers", () => {
    const valid = validYaml
      .replace('provider: "auto"', 'provider: "anthropic"\n    model: "claude-3-5-sonnet-latest"')
      .replace("enabled: false", "enabled: true")
      .replace('provider: "mock"\n    requireIndependentProvider: false', 'provider: "mock"\n    requireIndependentProvider: true');
    const path = writeConfig(valid);
    expect(() => loadConfig(path)).not.toThrow();
  });

  it("throws a clear error for a missing file", () => {
    expect(() => loadConfig("/nonexistent/qa.config.yaml")).toThrow(
      ConfigError
    );
  });
});
