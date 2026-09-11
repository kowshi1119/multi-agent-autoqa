import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../logger.js";
import type { CriticProvider } from "../models/critic-provider.js";
import { CriticOutputInvalidError } from "../models/critic-provider.js";
import type { UsageTracker } from "../models/usage-tracker.js";
import type { CriticDecision, CriticInput } from "../types.js";
import { CRITIC_SYSTEM_PROMPT, criticDecisionSchema, formatCriticUserMessage } from "./schema.js";

function extractJsonText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? text).trim();
}

function extractAnthropicUsage(response: Anthropic.Message): { input: number; output: number } | null {
  return response.usage ? { input: response.usage.input_tokens, output: response.usage.output_tokens } : null;
}

/**
 * Real critic adapter. Never invoked by the Phase-2 acceptance run (no
 * ANTHROPIC_API_KEY is configured in this environment) but wired up so a
 * future run with credentials exercises the same CriticProvider contract.
 * Mirrors AnthropicModelProvider's exact one-repair-then-fail pattern.
 */
export class AnthropicCriticProvider implements CriticProvider {
  name = "anthropic";
  modelId: string;

  private readonly client: Anthropic;
  private requestCounter = 0;

  constructor(
    apiKey: string,
    private readonly logger: Logger,
    model: string,
    private readonly usageTracker?: UsageTracker
  ) {
    // maxRetries:0 -- see src/models/explabs-client.ts's comment on the same setting.
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
    this.modelId = model;
  }

  async critique(input: CriticInput, signal?: AbortSignal): Promise<CriticDecision> {
    const userMessage = formatCriticUserMessage(input);

    const first = await this.complete(userMessage, signal);
    const firstParsed = this.tryParse(first);
    if (firstParsed) return firstParsed;

    this.logger.warn(
      { code: "CRITIC_OUTPUT_INVALID" },
      "Critic output failed validation; attempting one repair call."
    );

    const repairMessage = `Your previous response was not valid JSON matching the required schema. Your previous response was:\n\n${first}\n\nRespond again with ONLY a corrected JSON object.`;
    const repaired = await this.complete(repairMessage, signal);
    const repairedParsed = this.tryParse(repaired);
    if (repairedParsed) return repairedParsed;

    throw new CriticOutputInvalidError(
      "CRITIC_OUTPUT_INVALID: critic output did not match the required schema after one repair attempt."
    );
  }

  /** The actual SDK request boundary (Phase 4 continuation accounting fix) -- usage recorded here, once per real HTTP attempt. */
  private async complete(userMessage: string, signal?: AbortSignal): Promise<string> {
    this.requestCounter += 1;
    const attemptNumber = this.requestCounter;
    const call = (): Promise<Anthropic.Message> =>
      this.client.messages.create(
        {
          model: this.modelId,
          max_tokens: 1024,
          system: CRITIC_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        },
        signal ? { signal } : undefined
      );
    const response = this.usageTracker
      ? await this.usageTracker.recordAttempt(this.name, "critic", attemptNumber, call, extractAnthropicUsage)
      : await call();

    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  private tryParse(text: string): CriticDecision | null {
    try {
      const json = JSON.parse(extractJsonText(text));
      const result = criticDecisionSchema.safeParse(json);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}
