import OpenAI from "openai";

const EXPLABS_BASE_URL = "https://api.experientiallabs.ai/v1";

/** OpenAI-compatible client used only by the explicitly configured explabs provider. */
export class ExplabsClient {
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new OpenAI({ apiKey, baseURL: EXPLABS_BASE_URL });
  }

  async complete(system: string, user: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return response.choices[0]?.message.content ?? "";
  }
}
