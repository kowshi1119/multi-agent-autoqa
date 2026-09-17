import type { AgentRole } from "./model-router.js";

export type ProviderId = "mock" | "anthropic" | "openai" | "ollama" | "explabs" | "gemini";

/** Resolves credentials centrally; provider and role always come from configuration, never key prefixes. */
export function resolveProviderCredential(provider: ProviderId, role: AgentRole): string | undefined {
  if (provider === "anthropic") return process.env["ANTHROPIC_API_KEY"];
  if (provider === "gemini" && role === "explorer") return process.env["GEMINI_API_KEY"];
  if (provider === "openai") return process.env["OPENAI_API_KEY"];
  if (provider === "explabs") {
    const roleKey = role === "explorer" ? "EXPLABS_EXPLORER_API_KEY" : "EXPLABS_CRITIC_API_KEY";
    return process.env[roleKey] || process.env["EXPLABS_API_KEY"];
  }
  return undefined;
}
