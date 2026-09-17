import { ApiError, GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { explorerDecisionSchema } from "../actions.js";
import { ModelBudgetExhaustedError, type BudgetTracker } from "../budget.js";
import { ConfigError } from "../config.js";
import { EXPLORER_SYSTEM_PROMPT, formatUserMessage } from "../explorer.js";
import type { Logger } from "../logger.js";
import { redactSecrets } from "../redact.js";
import type { ExplorerDecision, ExplorerInput } from "../types.js";
import { ModelOutputInvalidError, type ExplorerProvider } from "./provider.js";
import type { UsageTracker } from "./usage-tracker.js";

type GeminiFailure = "authentication" | "rate_limit" | "model_not_found" | "invalid_request" | "unavailable" | "timeout" | "cancelled" | "initialization" | "blocked_response" | "unexpected_response";

/** Never retains an SDK error/cause: those can contain credentials and request bodies. */
export class GeminiProviderError extends Error {
  constructor(readonly kind: GeminiFailure) {
    super(`LLM_PROVIDER_ERROR: Gemini ${kind === "timeout" ? "request timeout" : kind}. This is a provider failure, not an application defect.`);
    this.name = "GeminiProviderError";
  }
}

function abortError(signal: AbortSignal): GeminiProviderError {
  return new GeminiProviderError(signal.reason instanceof Error && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled");
}

function safeError(error: unknown, signal?: AbortSignal): GeminiProviderError {
  if (signal?.aborted) return abortError(signal);
  if (error instanceof Error && error.name === "TimeoutError") return new GeminiProviderError("timeout");
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return new GeminiProviderError("authentication");
    if (error.status === 429) return new GeminiProviderError("rate_limit");
    if (error.status === 404) return new GeminiProviderError("model_not_found");
    if (error.status === 408 || error.status === 504) return new GeminiProviderError("timeout");
    if (error.status >= 400 && error.status < 500) return new GeminiProviderError("invalid_request");
  }
  return new GeminiProviderError("unavailable");
}

function tokenUsage(response: GenerateContentResponse): { input: number; output: number } | null {
  const usage = response.usageMetadata;
  const input = usage?.promptTokenCount;
  const candidates = usage?.candidatesTokenCount;
  const thoughts = usage?.thoughtsTokenCount ?? 0;
  if (![input, candidates, thoughts].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return null;
  // Thinking tokens are output too; never present just visible text tokens as total output.
  return { input: input!, output: candidates! + thoughts };
}

/** Text/DOM Explorer adapter only. No browser tools, image uploads, or defect-verdict schema. */
export class GeminiModelProvider implements ExplorerProvider {
  readonly name = "gemini";
  readonly modelId: string;
  private readonly client: GoogleGenAI;
  private requestCounter = 0;

  constructor(
    private readonly apiKey: string,
    private readonly logger: Logger,
    model: string,
    private readonly usageTracker?: UsageTracker,
    private readonly budget?: BudgetTracker,
    private readonly timeoutMs = 30_000
  ) {
    if (!apiKey.trim() || !model.trim()) {
      throw new ConfigError("MODEL_CONFIGURATION_ERROR: Gemini Explorer requires GEMINI_API_KEY and models.explorer.model.");
    }
    this.modelId = model;
    try {
      this.client = new GoogleGenAI({
        apiKey,
        vertexai: false,
        httpOptions: {
          baseUrl: "https://generativelanguage.googleapis.com",
          apiVersion: "v1beta",
          timeout: timeoutMs,
          // Includes the original attempt: 1 disables hidden transport retries.
          retryOptions: { attempts: 1 },
        },
      });
    } catch {
      throw new GeminiProviderError("initialization");
    }
  }

  async decideNextAction(input: ExplorerInput, signal?: AbortSignal): Promise<ExplorerDecision> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const secrets = [this.apiKey, ...(input.extraSecrets ?? [])];
    const user = redactSecrets(formatUserMessage(input), secrets);
    // Same display boundary as formatUserMessage. Stop is always permitted by Explorer.
    const offeredIds = [...new Set([...input.candidates.slice(0, 25).map((c) => c.id), "stop"])];
    const schemaIds = offeredIds.filter((id) => redactSecrets(id, secrets) === id);
    const responseJsonSchema = {
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
        responseJsonSchema,
        signal
      );
      if (signal?.aborted) throw abortError(signal);
      try {
        // Existing shared contract, strict at this provider boundary. Neither schema nor
        // parsing grants the model authority to add observations or confirm findings.
        const result = explorerDecisionSchema.strict().safeParse(JSON.parse(redactSecrets(text, secrets)));
        if (result.success && schemaIds.includes(result.data.candidateId)) return result.data;
      } catch {
        // Malformed output is eligible for exactly one budgeted repair, never logged/echoed.
      }
      if (attempt === 0) {
        this.logger.warn({ code: "MODEL_OUTPUT_INVALID", provider: this.name }, "Gemini decision invalid; attempting one budgeted repair.");
      }
    }
    throw new ModelOutputInvalidError("Gemini Explorer output did not match the required decision schema after one repair attempt.");
  }

  private async complete(user: string, responseJsonSchema: unknown, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw abortError(signal);
    if (this.budget && !this.budget.canCallModel()) throw new ModelBudgetExhaustedError();
    this.budget?.recordModelCall();
    this.requestCounter += 1;
    const call = async (): Promise<GenerateContentResponse> => {
      try {
        return await this.client.models.generateContent({
          model: this.modelId,
          contents: [{ role: "user", parts: [{ text: user }] }],
          config: {
            systemInstruction: EXPLORER_SYSTEM_PROMPT,
            responseMimeType: "application/json",
            responseJsonSchema,
            maxOutputTokens: 2048,
            candidateCount: 1,
            abortSignal: signal,
          },
        });
      } catch (error) {
        throw safeError(error, signal);
      }
    };
    const response = this.usageTracker
      ? await this.usageTracker.recordAttempt(this.name, "explorer", this.requestCounter, call, tokenUsage)
      : await call();
    if (response.promptFeedback?.blockReason) throw new GeminiProviderError("blocked_response");
    const candidate = response.candidates?.[0];
    if (candidate?.finishReason && !["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) {
      throw new GeminiProviderError("blocked_response");
    }
    const parts = candidate?.content?.parts ?? [];
    if (parts.some((part) => part.functionCall || part.executableCode || part.inlineData || part.fileData)) {
      throw new GeminiProviderError("unexpected_response");
    }
    // Avoid response.text's warning side effects; never print provider content or thought parts.
    return parts.filter((part) => !part.thought).map((part) => part.text ?? "").join("");
  }
}
