import { explorerDecisionSchema } from "../actions.js";
import { ModelBudgetExhaustedError, type BudgetTracker } from "../budget.js";
import { ConfigError } from "../config.js";
import { EXPLORER_SYSTEM_PROMPT, formatUserMessage } from "../explorer.js";
import type { Logger } from "../logger.js";
import { redactSecrets } from "../redact.js";
import type { ExplorerDecision, ExplorerInput } from "../types.js";
import { ModelOutputInvalidError, type ExplorerProvider } from "./provider.js";
import type { UsageTracker } from "./usage-tracker.js";

type OllamaFailure = "server_unavailable" | "model_not_found" | "invalid_response" | "timeout" | "cancelled" | "initialization";

/** Never retains the raw response body: it can contain fragments of the local model's own output about page content. */
export class OllamaProviderError extends Error {
  constructor(readonly kind: OllamaFailure, detail?: string) {
    super(`LLM_PROVIDER_ERROR: Ollama ${kind === "timeout" ? "request timeout" : kind.replace(/_/g, " ")}${detail ? `: ${detail}` : ""}. This is a provider failure, not an application defect.`);
    this.name = "OllamaProviderError";
  }
}

/**
 * Only http://127.0.0.1, http://localhost, and http://[::1] (any port) are
 * accepted -- this is a local-only adapter and must never be pointed at a
 * remote host, even one configured by mistake. Rejecting here, once, at
 * construction, is simpler and more auditable than trying to re-validate
 * scattered call sites.
 */
export function assertLocalOnlyUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError(`MODEL_CONFIGURATION_ERROR: OLLAMA_BASE_URL "${rawUrl}" is not a valid URL.`);
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  if (url.protocol !== "http:" || !isLoopback) {
    throw new ConfigError(
      `MODEL_CONFIGURATION_ERROR: OLLAMA_BASE_URL must be a loopback http URL (127.0.0.1/localhost/::1); got "${rawUrl}". This adapter never contacts a remote or cloud host.`
    );
  }
  return url;
}

function abortError(signal: AbortSignal): OllamaProviderError {
  return new OllamaProviderError(signal.reason instanceof Error && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled");
}

function tokenUsage(body: { prompt_eval_count?: unknown; eval_count?: unknown }): { input: number; output: number } | null {
  const input = body.prompt_eval_count;
  const output = body.eval_count;
  if (typeof input !== "number" || typeof output !== "number" || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0) {
    return null;
  }
  return { input, output };
}

/** Text/DOM Explorer adapter for a local Ollama server. No screenshots, tools, or defect-verdict schema -- same boundary as every other ExplorerProvider here. */
export class OllamaModelProvider implements ExplorerProvider {
  readonly name = "ollama";
  readonly modelId: string;
  private readonly baseUrl: URL;
  private requestCounter = 0;

  constructor(
    baseUrl: string,
    model: string,
    private readonly logger: Logger,
    private readonly usageTracker?: UsageTracker,
    private readonly budget?: BudgetTracker,
    private readonly timeoutMs = 30_000
  ) {
    if (!model.trim()) {
      throw new ConfigError("MODEL_CONFIGURATION_ERROR: Ollama Explorer requires OLLAMA_MODEL and models.explorer.model.");
    }
    this.modelId = model;
    this.baseUrl = assertLocalOnlyUrl(baseUrl);
  }

  async decideNextAction(input: ExplorerInput, signal?: AbortSignal): Promise<ExplorerDecision> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const secrets = [...(input.extraSecrets ?? [])];
    const user = redactSecrets(formatUserMessage(input), secrets);
    // Same display boundary as formatUserMessage. Stop is always permitted by Explorer.
    const offeredIds = [...new Set([...input.candidates.slice(0, 25).map((c) => c.id), "stop"])];
    const schemaIds = offeredIds.filter((id) => redactSecrets(id, secrets) === id);
    const format = {
      type: "object",
      properties: {
        candidateId: { type: "string", enum: schemaIds },
        testingIntent: { type: "string" },
        reason: { type: "string" },
      },
      required: ["candidateId", "testingIntent", "reason"],
      additionalProperties: false,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const text = await this.complete(
        attempt === 0 ? user : `${user}\n\nYour previous response was invalid. Return ONLY the required JSON object using an offered candidateId. Do not add actions, evidence, or verdict fields.`,
        format,
        signal
      );
      if (signal.aborted) throw abortError(signal);
      try {
        // Existing shared contract, strict at this provider boundary -- schema
        // acceptance never grants the model authority to add observations or
        // confirm findings.
        const result = explorerDecisionSchema.strict().safeParse(JSON.parse(redactSecrets(text, secrets)));
        if (result.success && schemaIds.includes(result.data.candidateId)) return result.data;
      } catch {
        // Malformed output is eligible for exactly one budgeted repair, never logged/echoed.
      }
      if (attempt === 0) {
        this.logger.warn({ code: "MODEL_OUTPUT_INVALID", provider: this.name }, "Ollama decision invalid; attempting one budgeted repair.");
      }
    }
    throw new ModelOutputInvalidError("Ollama Explorer output did not match the required decision schema after one repair attempt.");
  }

  private async complete(user: string, format: unknown, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw abortError(signal);
    if (this.budget && !this.budget.canCallModel()) throw new ModelBudgetExhaustedError();
    this.budget?.recordModelCall();
    this.requestCounter += 1;
    const call = async (): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
      let response: Response;
      try {
        response = await fetch(new URL("/api/chat", this.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: this.modelId,
            messages: [
              { role: "system", content: EXPLORER_SYSTEM_PROMPT },
              { role: "user", content: user },
            ],
            stream: false,
            format,
            options: { temperature: 0 },
          }),
          signal,
          // A local-only adapter must never silently follow a redirect off loopback.
          redirect: "manual",
        });
      } catch (error) {
        if (signal.aborted) throw abortError(signal);
        throw new OllamaProviderError("server_unavailable", "could not connect to the local Ollama server");
      }
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new OllamaProviderError("server_unavailable", "server attempted a redirect, which this local-only adapter refuses to follow");
      }
      if (response.status === 404) {
        const body = await response.text().catch(() => "");
        throw new OllamaProviderError("model_not_found", /not found|try pulling/i.test(body) ? "model is not pulled locally" : undefined);
      }
      if (!response.ok) {
        throw new OllamaProviderError("invalid_response", `HTTP ${response.status}`);
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new OllamaProviderError("invalid_response", "response body was not valid JSON");
      }
      const body = parsed as { message?: { content?: unknown }; done?: boolean; prompt_eval_count?: unknown; eval_count?: unknown };
      const text = body.message?.content;
      if (typeof text !== "string") throw new OllamaProviderError("invalid_response", "no message.content in response");
      return { text, usage: tokenUsage(body) };
    };
    const wrapped = async (): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
      try {
        return await call();
      } catch (error) {
        if (signal.aborted) throw abortError(signal);
        throw error;
      }
    };
    const result = this.usageTracker
      ? await this.usageTracker.recordAttempt(this.name, "explorer", this.requestCounter, wrapped, (r) => r.usage)
      : await wrapped();
    return result.text;
  }
}
