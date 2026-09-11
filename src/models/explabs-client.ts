import OpenAI from "openai";

const EXPLABS_BASE_URL = "https://api.experientiallabs.ai/v1";

export type ExplabsCompletionResult = {
  text: string;
  /** null when the response carried no usage field -- never fabricated. */
  tokenUsage: { input: number; output: number } | null;
};

/** OpenAI-compatible client used only by the explicitly configured explabs provider. */
export class ExplabsClient {
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model: string) {
    // maxRetries:0 -- the SDK defaults to 2 hidden internal retries on
    // 429/5xx, which would make every budget/usage counter in this
    // codebase (BudgetTracker.modelCalls/criticCalls, Phase 4's
    // UsageTracker) silently undercount real network requests. AutoQA's
    // own bounded budgets are the single source of truth for request
    // counting instead.
    this.client = new OpenAI({ apiKey, baseURL: EXPLABS_BASE_URL, maxRetries: 0 });
  }

  /** `signal` (Phase 4 continuation) is forwarded to the SDK's own per-request options so a timeout/Stop genuinely aborts this HTTP call. */
  async complete(system: string, user: string, signal?: AbortSignal): Promise<ExplabsCompletionResult> {
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      signal ? { signal } : undefined
    );
    const text = response.choices[0]?.message.content ?? "";
    const tokenUsage = response.usage ? { input: response.usage.prompt_tokens, output: response.usage.completion_tokens } : null;
    return { text, tokenUsage };
  }
}
