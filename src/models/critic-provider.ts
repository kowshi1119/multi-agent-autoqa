import type { CriticDecision, CriticInput } from "../types.js";

export class CriticOutputInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CriticOutputInvalidError";
  }
}

/** Timeout, rate limit, invalid response after repair, or provider outage — distinct from a bad-but-parseable verdict. */
export class CriticUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CriticUnavailableError";
  }
}

/**
 * The Critic gets READ-ONLY evidence only — no browser control, filesystem
 * mutation, shell, Git, network navigation, external messaging, secrets,
 * or Playwright tool access. It reviews evidence; it cannot independently
 * browse. This is deliberate (§58).
 */
export interface CriticProvider {
  name: string;
  modelId?: string;

  /**
   * Resolves with a schema-valid decision, or rejects with
   * CriticOutputInvalidError (bad JSON/schema after one repair) or
   * CriticUnavailableError (timeout/outage). Both map to
   * reportDisposition="needs_human" — never auto-report on failure.
   */
  critique(input: CriticInput): Promise<CriticDecision>;
}
