import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderCredential } from "../../src/models/provider-credentials.js";

const credentialNames = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "EXPLABS_API_KEY",
  "EXPLABS_EXPLORER_API_KEY",
  "EXPLABS_CRITIC_API_KEY",
] as const;
const originalEnvironment = Object.fromEntries(credentialNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of credentialNames) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

describe("resolveProviderCredential", () => {
  it("resolves the official provider credentials by configured provider", () => {
    process.env.ANTHROPIC_API_KEY = "test_key_DO_NOT_USE_12345";
    process.env.OPENAI_API_KEY = "test_openai_DO_NOT_USE_12345";

    expect(resolveProviderCredential("anthropic", "explorer")).toBe("test_key_DO_NOT_USE_12345");
    expect(resolveProviderCredential("openai", "critic")).toBe("test_openai_DO_NOT_USE_12345");
  });

  it("uses the experimental fallback credential when no role-specific key exists", () => {
    process.env.EXPLABS_API_KEY = "test_explabs_DO_NOT_USE_12345";

    expect(resolveProviderCredential("explabs", "explorer")).toBe("test_explabs_DO_NOT_USE_12345");
    expect(resolveProviderCredential("explabs", "critic")).toBe("test_explabs_DO_NOT_USE_12345");
  });

  it("prefers role-specific experimental credentials", () => {
    process.env.EXPLABS_API_KEY = "test_explabs_DO_NOT_USE_12345";
    process.env.EXPLABS_EXPLORER_API_KEY = "test_explorer_DO_NOT_USE_12345";
    process.env.EXPLABS_CRITIC_API_KEY = "test_critic_DO_NOT_USE_12345";

    expect(resolveProviderCredential("explabs", "explorer")).toBe("test_explorer_DO_NOT_USE_12345");
    expect(resolveProviderCredential("explabs", "critic")).toBe("test_critic_DO_NOT_USE_12345");
  });
});