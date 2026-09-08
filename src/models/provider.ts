import type { ExplorerDecision, ExplorerInput } from "../types.js";

export class ModelOutputInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputInvalidError";
  }
}

export interface ExplorerProvider {
  name: string;

  /**
   * Resolves with a schema-valid decision, or rejects with
   * ModelOutputInvalidError after the provider's own repair attempt fails.
   */
  decideNextAction(input: ExplorerInput): Promise<ExplorerDecision>;
}
