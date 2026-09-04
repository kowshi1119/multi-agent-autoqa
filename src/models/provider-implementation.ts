import Anthropic from "@anthropic-ai/sdk";
import { explorerDecisionSchema } from "../actions.js";
import { EXPLORER_SYSTEM_PROMPT, formatUserMessage } from "../explorer.js";
import type { Logger } from "../logger.js";
import type { ExplorerDecision, ExplorerInput, TestCandidate } from "../types.js";
import { ModelOutputInvalidError, type ModelProvider } from "./provider.js";

/**
 * Deterministic provider used for the acceptance run and tests. Default
 * strategy picks the first non-stop candidate every time; combined with the
 * Planner's own priority sort + heuristic-tracking exclusion (an
 * already-tested combo is never offered again), "always pick first" alone
 * drives full, non-repeating coverage across cycles with no state of its
 * own. An injectable `selectFn` lets a specific test force a particular
 * choice (e.g. to deterministically exercise one heuristic or page).
 */
export class MockModelProvider implements ModelProvider {
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
export class AnthropicModelProvider implements ModelProvider {
  name = "anthropic";

  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly logger: Logger,
    private readonly model: string
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async decideNextAction(input: ExplorerInput): Promise<ExplorerDecision> {
    const userMessage = `${formatUserMessage(input)}\n\n${RESPONSE_SCHEMA_INSTRUCTIONS}`;

    const first = await this.complete(userMessage);
    const firstParsed = this.tryParse(first);
    if (firstParsed) return firstParsed;

    this.logger.warn(
      { code: "MODEL_OUTPUT_INVALID" },
      "Explorer model output failed validation; attempting one repair call."
    );

    const repairMessage = `Your previous response was not valid JSON matching the required schema. Your previous response was:\n\n${first}\n\nRespond again with ONLY a corrected JSON object matching the schema below.\n\n${RESPONSE_SCHEMA_INSTRUCTIONS}`;
    const repaired = await this.complete(repairMessage);
    const repairedParsed = this.tryParse(repaired);
    if (repairedParsed) return repairedParsed;

    throw new ModelOutputInvalidError(
      "Explorer model output did not match the required schema after one repair attempt."
    );
  }

  private async complete(userMessage: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: EXPLORER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

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
