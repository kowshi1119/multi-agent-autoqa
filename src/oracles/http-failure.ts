import type { Oracle } from "../oracles.js";
import type { NetworkRecord, Observation, OracleResult } from "../types.js";
import { newItemsByKey } from "./multiset-diff.js";

function isServerFailure(record: NetworkRecord): boolean {
  return typeof record.status === "number" && record.status >= 500;
}

function key(record: NetworkRecord): string {
  return `${record.method} ${record.url} ${record.status}`;
}

/**
 * Detects newly occurring HTTP 5xx responses. 4xx responses are filtered
 * out before any comparison happens — they never participate in the
 * multiset diff at all, so they can never be auto-classified as a defect
 * regardless of how many occur.
 */
export function createHttpFailureOracle(): Oracle {
  return {
    id: "http-failure",
    // eslint-disable-next-line @typescript-eslint/require-await
    async evaluate(before: Observation, _action, after: Observation): Promise<OracleResult> {
      const beforeFailures = before.networkRequests.filter(isServerFailure);
      const afterFailures = after.networkRequests.filter(isServerFailure);

      const remaining = newItemsByKey(beforeFailures, afterFailures, key);
      const suspicious = remaining.length > 0;

      return {
        oracleId: "http-failure",
        suspicious,
        expected: "0 new HTTP 5xx responses",
        actual: `${remaining.length} new HTTP 5xx response${remaining.length === 1 ? "" : "s"}`,
        ...(suspicious
          ? { details: { newFailures: remaining.map((r) => ({ method: r.method, url: r.url, status: r.status })) } }
          : {}),
      };
    },
  };
}
