import { normalizePathname } from "../mapping/state-signature.js";
import type { ConsoleRecord, NetworkRecord, OracleResult } from "../types.js";

export type ScopedSelection<T> = { selected: T[]; totalCaptured: number; omitted: number };

function triggeringConsoleTexts(oracle: OracleResult): Set<string> {
  const details = oracle.details as Record<string, unknown> | undefined;
  const newErrors = (details?.["newErrors"] as string[] | undefined) ?? [];
  return new Set(newErrors);
}

/**
 * Forces inclusion of every console message the triggering oracle's own
 * `details.newErrors` references (so truncation can never drop the fact
 * that first proved the finding), then fills the remaining budget with
 * the most recent entries. Callers must always disclose `totalCaptured`/
 * `omitted` alongside `selected` -- missing evidence must never look like
 * an observed-empty list.
 */
export function selectConsoleEvidence(all: ConsoleRecord[], triggering: OracleResult, limit: number): ScopedSelection<ConsoleRecord> {
  const mustInclude = triggeringConsoleTexts(triggering);
  const forced = all.filter((m) => mustInclude.has(m.text));
  const rest = all.filter((m) => !mustInclude.has(m.text));
  const remainingBudget = Math.max(0, limit - forced.length);
  const selected = [...forced, ...rest.slice(-remainingBudget)];
  return { selected, totalCaptured: all.length, omitted: Math.max(0, all.length - selected.length) };
}

function triggeringNetworkKey(record: { method: string; url: string; status?: number }): string {
  return `${record.method} ${record.url} ${record.status ?? ""}`;
}

export type ScopedNetworkSelection = ScopedSelection<NetworkRecord> & {
  /** ALL network traffic captured this attempt -- the denominator an endpoint-specific count must never be silently compared against without saying so. */
  totalPageRequests: number;
  /** Of totalPageRequests, how many hit the SAME method+pathname the triggering oracle actually flagged. */
  matchedForTriggeringEndpoint: number;
};

/**
 * Same force-include-then-fill idiom as selectConsoleEvidence, plus the
 * scope-disclosure the spec explicitly requires: an endpoint-specific
 * request count must never be compared against all page traffic without
 * both numbers being visible.
 */
export function selectNetworkEvidence(all: NetworkRecord[], triggering: OracleResult, limit: number): ScopedNetworkSelection {
  const details = triggering.details as Record<string, unknown> | undefined;
  const newFailures = (details?.["newFailures"] as Array<{ method: string; url: string; status?: number }> | undefined) ?? [];
  const mustIncludeKeys = new Set(newFailures.map(triggeringNetworkKey));

  const forced = all.filter((r) => mustIncludeKeys.has(triggeringNetworkKey(r)));
  const rest = all.filter((r) => !mustIncludeKeys.has(triggeringNetworkKey(r)));
  const remainingBudget = Math.max(0, limit - forced.length);
  const selected = [...forced, ...rest.slice(-remainingBudget)];

  const triggeringEndpoints = new Set(newFailures.map((f) => `${f.method}|${normalizePathname(f.url)}`));
  const matchedForTriggeringEndpoint =
    triggeringEndpoints.size > 0
      ? all.filter((r) => triggeringEndpoints.has(`${r.method}|${normalizePathname(r.url)}`)).length
      : 0;

  return {
    selected,
    totalCaptured: all.length,
    omitted: Math.max(0, all.length - selected.length),
    totalPageRequests: all.length,
    matchedForTriggeringEndpoint,
  };
}
