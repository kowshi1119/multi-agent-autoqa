import type { ExplorerDecision, ExplorerInput } from "../types.js";

export class ModelOutputInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputInvalidError";
  }
}

export interface ExplorerProvider {
  name: string;
  /** Absent for the deterministic mock provider -- present for anthropic/explabs, mirroring CriticProvider.modelId. Used only for usage/cost reporting (Phase 4 Milestone D1), never a live decision input. */
  modelId?: string;

  /**
   * Resolves with a schema-valid decision, or rejects with
   * ModelOutputInvalidError after the provider's own repair attempt fails.
   *
   * `signal` (Phase 4 continuation cancellation fix), when provided, is
   * passed straight into the underlying SDK request so a timeout or a
   * user-initiated Stop genuinely aborts an in-flight call rather than
   * merely abandoning it. Absent for the deterministic mock provider,
   * which makes no real request to abort.
   */
  decideNextAction(input: ExplorerInput, signal?: AbortSignal): Promise<ExplorerDecision>;
}
