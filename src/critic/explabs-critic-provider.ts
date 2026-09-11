import type { Logger } from "../logger.js";
import { ExplabsClient } from "../models/explabs-client.js";
import { CriticOutputInvalidError, type CriticProvider } from "../models/critic-provider.js";
import type { UsageTracker } from "../models/usage-tracker.js";
import type { CriticDecision, CriticInput } from "../types.js";
import { CRITIC_SYSTEM_PROMPT, criticDecisionSchema, formatCriticUserMessage } from "./schema.js";

function extractJsonText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? text).trim();
}

export class ExplabsCriticProvider implements CriticProvider {
  name = "explabs";
  modelId: string;

  private readonly client: ExplabsClient;
  private requestCounter = 0;

  constructor(apiKey: string, private readonly logger: Logger, model: string, private readonly usageTracker?: UsageTracker) {
    this.client = new ExplabsClient(apiKey, model);
    this.modelId = model;
  }

  async critique(input: CriticInput, signal?: AbortSignal): Promise<CriticDecision> {
    const first = await this.complete(CRITIC_SYSTEM_PROMPT, formatCriticUserMessage(input), signal);
    const firstParsed = this.tryParse(first);
    if (firstParsed) return firstParsed;

    this.logger.warn({ code: "CRITIC_OUTPUT_INVALID" }, "Critic output failed validation; attempting one repair call.");
    const repaired = await this.complete(
      CRITIC_SYSTEM_PROMPT,
      `Your previous response was not valid JSON matching the required schema. Your previous response was:\n\n${first}\n\nRespond again with ONLY a corrected JSON object.`,
      signal
    );
    const repairedParsed = this.tryParse(repaired);
    if (repairedParsed) return repairedParsed;

    throw new CriticOutputInvalidError(
      "CRITIC_OUTPUT_INVALID: critic output did not match the required schema after one repair attempt."
    );
  }

  /** The actual SDK request boundary (Phase 4 continuation accounting fix) -- see AnthropicCriticProvider#complete for the identical rationale. */
  private async complete(system: string, user: string, signal?: AbortSignal): Promise<string> {
    this.requestCounter += 1;
    const attemptNumber = this.requestCounter;
    const call = () => this.client.complete(system, user, signal);
    const result = this.usageTracker
      ? await this.usageTracker.recordAttempt(this.name, "critic", attemptNumber, call, (r) => r.tokenUsage)
      : await call();
    return result.text;
  }

  private tryParse(text: string): CriticDecision | null {
    try {
      const result = criticDecisionSchema.safeParse(JSON.parse(extractJsonText(text)));
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}
