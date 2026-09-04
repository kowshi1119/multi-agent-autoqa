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
heuristics:
  longTextBoundaryChars: 500
validation:
  attempts: 3
  minimumSuccesses: 2
evidence:
  screenshots: true
  trace: true
  console: true
  network: true
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

  it("throws a clear error for a missing file", () => {
    expect(() => loadConfig("/nonexistent/qa.config.yaml")).toThrow(
      ConfigError
    );
  });
});
