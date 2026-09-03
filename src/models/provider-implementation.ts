import Anthropic from "@anthropic-ai/sdk";
import { explorerDecisionSchema } from "../actions.js";
import { EXPLORER_SYSTEM_PROMPT, formatUserMessage } from "../explorer.js";
import type { Logger } from "../logger.js";
import type { ExplorerDecision, ExplorerInput } from "../types.js";
import { ModelOutputInvalidError, type ModelProvider } from "./provider.js";

/**
 * Deterministic provider used for the acceptance run and tests. Returns a
 * fixed queue of decisions regardless of observation content, so the whole
 * pipeline is reproducible without any live model call.
 */
export class MockModelProvider implements ModelProvider {
  name = "mock";

  private readonly queue: ExplorerDecision[];
  private index = 0;

  constructor(queue?: ExplorerDecision[]) {
    this.queue = queue ?? MockModelProvider.defaultQueue();
  }

  static defaultQueue(): ExplorerDecision[] {
    return [
      {
        action: {
          type: "click",
          target: { role: "button", name: "Submit" },
        },
        testingIntent: "Submit the local fixture form",
        reason: "The submit action exercises the seeded defect.",
      },
      {
        action: { type: "stop", reason: "The seeded defect has already been exercised." },
        testingIntent: "Stop after the deterministic oracle has been evaluated.",
        reason: "No additional action is required.",
      },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async decideNextAction(_input: ExplorerInput): Promise<ExplorerDecision> {
    const next = this.queue[this.index];
    if (!next) {
      return {
        action: { type: "stop", reason: "Mock provider queue exhausted." },
        testingIntent: "Stop; no further scripted actions remain.",
        reason: "The deterministic action queue has been fully consumed.",
      };
    }
    this.index += 1;
    return next;
  }
}

const RESPONSE_SCHEMA_INSTRUCTIONS = `Respond with ONLY a single JSON object (no markdown fences, no prose) matching exactly this shape:

{
  "action": {
    "type": "click" | "fill" | "press" | "reload" | "navigate" | "wait" | "stop",
    ... fields for that action type ...
  },
  "testingIntent": "short string",
  "reason": "short string"
}

Action field requirements:
- click: { "type": "click", "target": { "role"?, "name"?, "label"?, "text"?, "testId"? } } (at least one target field required)
- fill: { "type": "fill", "target": {...same as click...}, "value": "string" }
- press: { "type": "press", "target"?: {...}, "key": "string" }
- reload: { "type": "reload" }
- navigate: { "type": "navigate", "url": "string" }
- wait: { "type": "wait", "milliseconds": number }
- stop: { "type": "stop", "reason": "string" }`;

function extractJsonText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? text).trim();
}

/**
 * Real provider adapter. Never invoked by the Phase-0 acceptance run
 * (no ANTHROPIC_API_KEY is configured in this environment) but wired up
 * so a future run with credentials exercises the same interface.
 */
export class AnthropicModelProvider implements ModelProvider {
  name = "anthropic";

  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly logger: Logger,
    private readonly model = "claude-sonnet-5"
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
