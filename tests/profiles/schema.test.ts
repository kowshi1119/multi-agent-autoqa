import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { parseProfile, ProfileError } from "../../src/profiles/schema.js";
import { profileToAppConfig } from "../../src/profiles/to-app-config.js";
import { loadTestConfig } from "../helpers/test-config.js";

function loadShippedProfile(id: string): unknown {
  return JSON.parse(readFileSync(resolve("profiles", `${id}.json`), "utf-8"));
}

describe("ProjectProfile schema", () => {
  it("parses the shipped fixture profile", () => {
    const profile = parseProfile(loadShippedProfile("fixture"));
    expect(profile.id).toBe("fixture");
    expect(profile.target.environmentKind).toBe("local-fixture");
    expect(profile.auth.mode).toBe("none");
  });

  it("parses the shipped orangehrm profile", () => {
    const profile = parseProfile(loadShippedProfile("orangehrm"));
    expect(profile.id).toBe("orangehrm");
    expect(profile.target.environmentKind).toBe("self-hosted-real-app");
    expect(profile.auth.mode).toBe("form-login");
  });

  it("rejects a form-login profile missing required locator fields", () => {
    const bad = {
      ...(parseProfile(loadShippedProfile("orangehrm")) as object),
      auth: { mode: "form-login" },
    };
    expect(() => parseProfile(bad)).toThrow(ProfileError);
  });

  it("rejects a profile with no allowed origins", () => {
    const bad = JSON.parse(JSON.stringify(loadShippedProfile("fixture"))) as Record<string, unknown>;
    (bad["navigation"] as Record<string, unknown>)["allowedOrigins"] = [];
    expect(() => parseProfile(bad)).toThrow(ProfileError);
  });

  it("rejects an unknown environmentKind", () => {
    const bad = JSON.parse(JSON.stringify(loadShippedProfile("fixture"))) as Record<string, unknown>;
    (bad["target"] as Record<string, unknown>)["environmentKind"] = "production";
    expect(() => parseProfile(bad)).toThrow(ProfileError);
  });

  it("rejects a form-login profile whose successUrlPattern is not a valid regular expression", () => {
    const bad = JSON.parse(JSON.stringify(loadShippedProfile("orangehrm"))) as Record<string, unknown>;
    (bad["auth"] as Record<string, unknown>)["successUrlPattern"] = "(unclosed[";
    expect(() => parseProfile(bad)).toThrow(ProfileError);
  });
});

describe("profileToAppConfig", () => {
  it("projects the fixture profile into a valid, schema-passing AppConfig", () => {
    const profile = parseProfile(loadShippedProfile("fixture"));
    const config = profileToAppConfig(profile);
    expect(config.target.environment).toBe("local-fixture");
    expect(config.target.url).toBe(profile.target.url);
    expect(config.safety.allowedOrigins).toEqual(profile.navigation.allowedOrigins);
    expect(config.evidence.trace).toBe(true);
  });

  it("defaults trace capture off for a non-fixture (real-target) profile", () => {
    const profile = parseProfile(loadShippedProfile("orangehrm"));
    const config = profileToAppConfig(profile);
    expect(config.target.environment).toBe("self-hosted-real-app");
    expect(config.evidence.trace).toBe(false);
  });
});

describe("legacy config compatibility", () => {
  it("a legacy qa.config.yaml with a free-form target.environment string still loads via loadConfig() unaffected by the profile layer", () => {
    const config = loadTestConfig((y) => y.replace('environment: "local-fixture"', 'environment: "some-legacy-value"'));
    expect(config.target.environment).toBe("some-legacy-value");
  });

  it("loadConfig() still works for the real repo's qa.config.yaml/qa.config.mock.yaml", () => {
    expect(() => loadConfig(resolve("qa.config.mock.yaml"))).not.toThrow();
  });
});
