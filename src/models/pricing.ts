import type { UsageSummary } from "./usage-tracker.js";

export type PricingEntry = {
  /** Where this rate was verified -- a pricing page URL or document name, never "estimated"/"approximate". */
  source: string;
  /** ISO date the rate was last confirmed against the source. */
  effectiveDate: string;
  inputPerMillion: number;
  outputPerMillion: number;
};

/**
 * Empty by design -- no provider/model pricing has been verified against
 * an authoritative source in this build. Calculate estimated dollars ONLY
 * from explicit verified pricing metadata with its source/date; if
 * pricing is unknown (the default), enforce request/time/output limits
 * instead and say monetary cost cannot be guaranteed. Do not display a
 * hard dollar cap unless this table (and estimateCostUsd below) can
 * actually enforce it -- an empty table is the honest state until a real
 * rate is added with its source cited.
 */
export const PRICING_TABLE: Record<string, PricingEntry> = {};

export type CostEstimate = { costUsd: number; basis: PricingEntry } | { costUsd: null; reason: string };

export function estimateCostUsd(modelId: string | undefined, usage: UsageSummary["explorer"] | UsageSummary["critic"]): CostEstimate {
  if (usage.requests === 0) return { costUsd: 0, basis: { source: "no requests made", effectiveDate: "", inputPerMillion: 0, outputPerMillion: 0 } };
  if (!modelId) return { costUsd: null, reason: "No model id available for this provider." };
  const entry = PRICING_TABLE[modelId];
  if (!entry) return { costUsd: null, reason: `No verified pricing metadata for "${modelId}" -- request/time/output limits are the enforced control instead.` };
  if (!usage.tokenUsage) return { costUsd: null, reason: "Token usage was not reported by the provider for one or more requests." };
  const costUsd = (usage.tokenUsage.input / 1_000_000) * entry.inputPerMillion + (usage.tokenUsage.output / 1_000_000) * entry.outputPerMillion;
  return { costUsd, basis: entry };
}

/**
 * Combined explorer+critic estimate for one run. Only ever a real number
 * when BOTH roles resolve to a real number (or zero requests) -- a
 * partial estimate is never silently presented as the whole run's cost.
 */
export function estimateRunCostUsd(
  explorerModelId: string | undefined,
  criticModelId: string | undefined,
  usage: UsageSummary
): { estimatedCostUsd: number | null; disclosure: string } {
  const explorerEstimate = estimateCostUsd(explorerModelId, usage.explorer);
  const criticEstimate = estimateCostUsd(criticModelId, usage.critic);

  if (explorerEstimate.costUsd !== null && criticEstimate.costUsd !== null) {
    return {
      estimatedCostUsd: explorerEstimate.costUsd + criticEstimate.costUsd,
      disclosure: "Estimated from verified pricing metadata for both roles; request/time/output limits remain the enforced control regardless.",
    };
  }
  const reasons = [
    explorerEstimate.costUsd === null ? `explorer: ${explorerEstimate.reason}` : null,
    criticEstimate.costUsd === null ? `critic: ${criticEstimate.reason}` : null,
  ].filter((r): r is string => r !== null);
  return {
    estimatedCostUsd: null,
    disclosure: `Monetary cost cannot be guaranteed (${reasons.join("; ")}). Request/time/output limits are the enforced control instead.`,
  };
}
