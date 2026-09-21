import "dotenv/config";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { redactSecrets } from "./redact.js";
import { resolveProviderCredential, type ProviderId } from "./models/provider-credentials.js";
import { assertLocalOnlyUrl, OllamaModelProvider } from "./models/ollama-provider.js";
import type { ExplorerInput } from "./types.js";

const EXPLABS_CHAT_COMPLETIONS_URL = "https://api.experientiallabs.ai/v1/chat/completions";

type ConfiguredRole = {
  name: "Explorer" | "Critic";
  provider: ProviderId;
  model?: string;
  enabled: boolean;
  providerTimeoutMs?: number;
};

function credentialStatus(role: ConfiguredRole): string {
  if (role.provider === "mock" || role.provider === "ollama") return "not required";
  return resolveProviderCredential(role.provider, role.name.toLowerCase() as "explorer" | "critic") ? "available" : "missing";
}

async function runLiveExplabsCheck(role: ConfiguredRole): Promise<void> {
  if (role.provider !== "explabs" || !role.model) {
    throw new Error("--live currently requires the enabled Explorer to use provider \"explabs\" with a configured model.");
  }
  const apiKey = resolveProviderCredential("explabs", "explorer");
  if (!apiKey) throw new Error("MODEL_CONFIGURATION_ERROR: EXPLABS_API_KEY missing for Explorer.");

  const response = await fetch(EXPLABS_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: role.model, messages: [{ role: "user", content: "Reply with OK." }] }),
  });
  if (!response.ok) throw new Error(`Live chat completion failed with HTTP ${response.status}.`);

  const body = (await response.json()) as { usage?: { cost?: number | string }; cost?: number | string };
  console.log("Live chat completion: succeeded");
  console.log(`Cost: ${body.usage?.cost ?? body.cost ?? "not reported by gateway"}`);
}

/**
 * Explicitly opt-in real local smoke check -- only reachable once the user
 * has installed Ollama and pulled the configured model themselves. Uses a
 * synthetic local observation, never authenticated/real application content
 * (this script has no browser session to draw one from anyway).
 */
async function runLiveOllamaCheck(role: ConfiguredRole): Promise<void> {
  if (role.provider !== "ollama" || !role.model) {
    throw new Error('--live currently requires the enabled Explorer to use provider "explabs" or "ollama" with a configured model.');
  }
  const baseUrl = process.env["OLLAMA_BASE_URL"]?.trim() || "http://127.0.0.1:11434";
  assertLocalOnlyUrl(baseUrl);

  const tagsResponse = await fetch(new URL("/api/tags", baseUrl)).catch(() => null);
  if (!tagsResponse?.ok) {
    throw new Error(`Ollama server not reachable at ${baseUrl}. Install Ollama and run \`ollama serve\` first — this check does not install anything.`);
  }
  const tags = (await tagsResponse.json()) as { models?: { name?: string }[] };
  const available = (tags.models ?? []).map((m) => m.name);
  if (!available.includes(role.model)) {
    throw new Error(`Model "${role.model}" is not pulled locally (available: ${available.join(", ") || "none"}). Run \`ollama pull ${role.model}\` first — this check does not download anything.`);
  }
  console.log(`Ollama server reachable at ${baseUrl}; model "${role.model}" is available locally.`);

  const syntheticInput: ExplorerInput = {
    observation: {
      timestamp: new Date().toISOString(), page: { url: "http://localhost:4173/", title: "AutoQA local fixture", pathname: "/" },
      viewport: { width: 1024, height: 768 }, visibleText: "AutoQA local fixture home page.", interactiveElements: [], forms: [], links: [],
      consoleMessages: [], pageErrors: [], networkRequests: [], dialogs: [], stateSignature: "smoke-check",
    },
    candidates: [],
    recentActions: [], remainingActions: 1, remainingModelCalls: 1, remainingDurationMs: role.providerTimeoutMs ?? 30_000,
  };
  const logger = createLogger();
  logger.level = "silent";
  const provider = new OllamaModelProvider(baseUrl, role.model, logger, undefined, undefined, role.providerTimeoutMs ?? 30_000);
  const startedAt = Date.now();
  const decision = await provider.decideNextAction(syntheticInput);
  console.log(`Live local decision: succeeded in ${Date.now() - startedAt}ms`);
  console.log(`Decision: candidateId=${decision.candidateId}`);
  console.log("Cost: $0 for verified local inference (hardware, electricity, storage, and download costs are not measured).");
}

async function main(): Promise<void> {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex < 0 ? "qa.config.yaml" : process.argv[configIndex + 1];
  if (!configPath || configPath.startsWith("--")) throw new Error("--config requires a file path.");
  const config = loadConfig(resolve(configPath));
  const explorerProvider: ProviderId =
    config.models.explorer.provider === "auto"
      ? resolveProviderCredential("anthropic", "explorer")
        ? "anthropic"
        : "mock"
      : config.models.explorer.provider;
  const roles: ConfiguredRole[] = [
    { name: "Explorer", provider: explorerProvider, model: config.models.explorer.model, enabled: true, providerTimeoutMs: config.models.providerTimeoutMs },
    { name: "Critic", ...config.models.critic, providerTimeoutMs: config.models.providerTimeoutMs },
  ];

  console.log("AutoQA Provider Check\n");
  for (const role of roles) {
    if (!role.enabled) {
      console.log(`${role.name}: disabled\n`);
      continue;
    }
    console.log(`${role.name}:`);
    console.log(`Provider: ${role.provider}`);
    console.log(`Model: ${redactSecrets(role.model ?? "not configured")}`);
    console.log(`Credential: ${credentialStatus(role)}\n`);
  }
  if (roles.some((role) => role.enabled && credentialStatus(role) === "missing")) {
    throw new Error("MODEL_CONFIGURATION_ERROR: a required provider credential is missing.");
  }
  if (process.argv.includes("--live")) {
    const explorer = roles[0]!;
    if (explorer.provider === "ollama") await runLiveOllamaCheck(explorer);
    else await runLiveExplabsCheck(explorer);
  }
  console.log("Secrets exposed in output: NO");
}

main().catch((error: unknown) => {
  console.error(redactSecrets(error instanceof Error ? error.message : "Provider check failed."));
  process.exitCode = 1;
});
