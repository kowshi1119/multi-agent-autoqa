import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "../../src/config.js";

export const VALID_TEST_YAML = `
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
heuristics:
  longTextBoundaryChars: 500
validation:
  attempts: 3
  minimumSuccesses: 2
oracles:
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
  provider: "mock"
  model: "claude-sonnet-5"
safety:
  safeMode: true
  allowedOrigins:
    - "http://localhost:4173"
`;

/** Loads a real, schema-validated AppConfig from a temp file, optionally mutated via a string transform. */
export function loadTestConfig(mutate: (yaml: string) => string = (y) => y): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "autoqa-test-config-"));
  const path = join(dir, "qa.config.yaml");
  writeFileSync(path, mutate(VALID_TEST_YAML), "utf-8");
  return loadConfig(path);
}
