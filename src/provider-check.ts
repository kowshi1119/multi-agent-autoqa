import "dotenv/config";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { redactSecrets } from "./redact.js";
import { resolveProviderCredential, type ProviderId } from "./models/provider-credentials.js";

const EXPLABS_CHAT_COMPLETIONS_URL = "https://api.experientiallabs.ai/v1/chat/completions";

type ConfiguredRole = {
  name: "Explorer" | "Critic";
  provider: ProviderId;
  model?: string;
  enabled: boolean;
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
    { name: "Explorer", provider: explorerProvider, model: config.models.explorer.model, enabled: true },
    { name: "Critic", ...config.models.critic },
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
  if (process.argv.includes("--live")) await runLiveExplabsCheck(roles[0]!);
  console.log("Secrets exposed in output: NO");
}

main().catch((error: unknown) => {
  console.error(redactSecrets(error instanceof Error ? error.message : "Provider check failed."));
  process.exitCode = 1;
});
