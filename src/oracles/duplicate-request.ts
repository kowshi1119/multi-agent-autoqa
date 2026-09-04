import type { AppConfig } from "../config.js";
import { normalizePathname } from "../mapping/state-signature.js";
import type { Oracle } from "../oracles.js";
import type { NetworkRecord, Observation, OracleResult } from "../types.js";

type DuplicateRequestPattern = { method: string; pathname: string; expectedMax: number };

function countMatches(requests: NetworkRecord[], pattern: DuplicateRequestPattern): number {
  return requests.filter(
    (r) => r.method === pattern.method && normalizePathname(r.url) === pattern.pathname
  ).length;
}

/**
 * Detects a configured request pattern occurring more times than expected
 * after one test interaction (e.g. a double-click producing two POSTs).
 * Purely a network-record count — never LLM interpretation.
 */
export function createDuplicateRequestOracle(config: AppConfig): Oracle {
  const patterns = config.oracles.duplicateRequest.patterns;

  return {
    id: "duplicate-request",
    // eslint-disable-next-line @typescript-eslint/require-await
    async evaluate(before: Observation, _action, after: Observation): Promise<OracleResult> {
      const violations: Array<{ method: string; pathname: string; expectedMax: number; newCount: number }> = [];

      for (const pattern of patterns) {
        const beforeCount = countMatches(before.networkRequests, pattern);
        const afterCount = countMatches(after.networkRequests, pattern);
        const newCount = afterCount - beforeCount;
        if (newCount > pattern.expectedMax) {
          violations.push({ method: pattern.method, pathname: pattern.pathname, expectedMax: pattern.expectedMax, newCount });
        }
      }

      const suspicious = violations.length > 0;
      const expectedSummary = patterns
        .map((p) => `${p.method} ${p.pathname} (max ${p.expectedMax})`)
        .join(", ");

      return {
        oracleId: "duplicate-request",
        suspicious,
        expected: patterns.length > 0 ? `No pattern exceeds its configured max: ${expectedSummary}` : "No duplicate-request patterns configured",
        actual: suspicious
          ? violations.map((v) => `${v.method} ${v.pathname}: ${v.newCount} new requests (max ${v.expectedMax})`).join("; ")
          : "All configured patterns stayed within their expected max",
        ...(suspicious ? { details: { violations } } : {}),
      };
    },
  };
}
