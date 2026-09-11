import Anthropic from "@anthropic-ai/sdk";
import { explorerDecisionSchema } from "../actions.js";
import { EXPLORER_SYSTEM_PROMPT, formatUserMessage } from "../explorer.js";
import type { Logger } from "../logger.js";
import type { ExplorerDecision, ExplorerInput, TestCandidate } from "../types.js";
import { ExplabsClient } from "./explabs-client.js";
import { ModelOutputInvalidError, type ExplorerProvider } from "./provider.js";
import type { UsageTracker } from "./usage-tracker.js";

/**
 * Deterministic provider used for the acceptance run and tests. Default
 * strategy picks the first non-stop candidate every time; combined with the
 * Planner's own priority sort + heuristic-tracking exclusion (an
 * already-tested combo is never offered again), "always pick first" alone
 * drives full, non-repeating coverage across cycles with no state of its
 * own. An injectable `selectFn` lets a specific test force a particular
 * choice (e.g. to deterministically exercise one heuristic or page).
 */
export class MockModelProvider implements ExplorerProvider {
  name = "mock";

  constructor(
    private readonly selectFn: (candidates: TestCandidate[]) => string = defaultSelect
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async decideNextAction(input: ExplorerInput): Promise<ExplorerDecision> {
    const candidateId = this.selectFn(input.candidates);
    return {
      candidateId,
      testingIntent: `Exercise candidate ${candidateId}`,
      reason: "Deterministic mock selection.",
    };
  }
}

function defaultSelect(candidates: TestCandidate[]): string {
  return candidates.find((c) => c.id !== "stop")?.id ?? "stop";
}

const RESPONSE_SCHEMA_INSTRUCTIONS = `Respond with ONLY a single JSON object (no markdown fences, no prose) matching exactly this shape:

{
  "candidateId": "<one id from the candidate list above, or \\"stop\\">",
  "testingIntent": "short string",
  "reason": "short string"
}`;

function extractJsonText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? text).trim();
}

/**
 * Real provider adapter. Never invoked by the Phase-1 acceptance run
 * (no ANTHROPIC_API_KEY is configured in this environment) but wired up
 * so a future run with credentials exercises the same interface.
 */
function extractAnthropicUsage(response: Anthropic.Message): { input: number; output: number } | null {
  return response.usage ? { input: response.usage.input_tokens, output: response.usage.output_tokens } : null;
}

export class AnthropicModelProvider implements ExplorerProvider {
  name = "anthropic";
  modelId: string;

  private readonly client: Anthropic;
  /** Counts real HTTP attempts (first + any repair) for UsageTracker -- distinct from Explorer's own logical-decision counter. */
  private requestCounter = 0;

  constructor(
    apiKey: string,
    private readonly logger: Logger,
    private readonly model: string,
    private readonly usageTracker?: UsageTracker
  ) {
    // maxRetries:0 -- see src/models/explabs-client.ts's comment on the same setting.
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
    this.modelId = model;
  }

  async decideNextAction(input: ExplorerInput, signal?: AbortSignal): Promise<ExplorerDecision> {
    const userMessage = `${formatUserMessage(input)}\n\n${RESPONSE_SCHEMA_INSTRUCTIONS}`;

    const first = await this.complete(userMessage, signal);
    const firstParsed = this.tryParse(first);
    if (firstParsed) return firstParsed;

    this.logger.warn(
      { code: "MODEL_OUTPUT_INVALID" },
      "Explorer model output failed validation; attempting one repair call."
    );

    const repairMessage = `Your previous response was not valid JSON matching the required schema. Your previous response was:\n\n${first}\n\nRespond again with ONLY a corrected JSON object matching the schema below.\n\n${RESPONSE_SCHEMA_INSTRUCTIONS}`;
    const repaired = await this.complete(repairMessage, signal);
    const repairedParsed = this.tryParse(repaired);
    if (repairedParsed) return repairedParsed;

    throw new ModelOutputInvalidError(
      "Explorer model output did not match the required schema after one repair attempt."
    );
  }

  /**
   * The actual SDK request boundary (Phase 4 continuation accounting fix)
   * -- usage is recorded HERE, once per real HTTP attempt, so a
   * first-fails-then-repairs decision counts as 2 requests, not 1. Moved
   * out of Explorer.decide()'s old outer wrapping, which only ever counted
   * one entry per logical decision regardless of how many real requests it
   * internally made.
   */
  private async complete(userMessage: string, signal?: AbortSignal): Promise<string> {
    this.requestCounter += 1;
    const attemptNumber = this.requestCounter;
    const call = (): Promise<Anthropic.Message> =>
      this.client.messages.create(
        {
          model: this.model,
          max_tokens: 1024,
          system: EXPLORER_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        },
        signal ? { signal } : undefined
      );
    const response = this.usageTracker
      ? await this.usageTracker.recordAttempt(this.name, "explorer", attemptNumber, call, extractAnthropicUsage)
      : await call();

    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  private tryParse(text: string): ExplorerDecision | null {
    try {
      const json = JSON.parse(extractJsonText(text));
      const result = explorerDecisionSchema.safeParse(json);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}

export class ExplabsModelProvider implements ExplorerProvider {
  name = "explabs";
  modelId: string;

  private readonly client: ExplabsClient;
  private requestCounter = 0;

  constructor(apiKey: string, private readonly logger: Logger, private readonly model: string, private readonly usageTracker?: UsageTracker) {
    this.client = new ExplabsClient(apiKey, model);
    this.modelId = model;
  }

  async decideNextAction(input: ExplorerInput, signal?: AbortSignal): Promise<ExplorerDecision> {
    const userMessage = `${formatUserMessage(input)}\n\n${RESPONSE_SCHEMA_INSTRUCTIONS}`;
    const first = await this.complete(EXPLORER_SYSTEM_PROMPT, userMessage, signal);
    const firstParsed = this.tryParse(first);
    if (firstParsed) return firstParsed;

    this.logger.warn({ code: "MODEL_OUTPUT_INVALID" }, "Explorer model output failed validation; attempting one repair call.");
    const repaired = await this.complete(
      EXPLORER_SYSTEM_PROMPT,
      `Your previous response was not valid JSON matching the required schema. Your previous response was:\n\n${first}\n\nRespond again with ONLY a corrected JSON object matching the schema below.\n\n${RESPONSE_SCHEMA_INSTRUCTIONS}`,
      signal
    );
    const repairedParsed = this.tryParse(repaired);
    if (repairedParsed) return repairedParsed;

    throw new ModelOutputInvalidError(
      "Explorer model output did not match the required schema after one repair attempt."
    );
  }

  /** The actual SDK request boundary (Phase 4 continuation accounting fix) -- see AnthropicModelProvider#complete for the identical rationale. */
  private async complete(system: string, user: string, signal?: AbortSignal): Promise<string> {
    this.requestCounter += 1;
    const attemptNumber = this.requestCounter;
    const call = () => this.client.complete(system, user, signal);
    const result = this.usageTracker
      ? await this.usageTracker.recordAttempt(this.name, "explorer", attemptNumber, call, (r) => r.tokenUsage)
      : await call();
    return result.text;
  }

  private tryParse(text: string): ExplorerDecision | null {
    try {
      const result = explorerDecisionSchema.safeParse(JSON.parse(extractJsonText(text)));
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}
