import type { AppConfig } from "../config.js";
import { normalizePathname } from "../mapping/state-signature.js";
import type { Oracle } from "../oracles.js";
import type { NetworkRecord, Observation, OracleResult } from "../types.js";
import { newItemsByKey } from "./multiset-diff.js";

export type UiApiConsistencyRule = {
  id: string;
  request: { method: string; pathname: string };
  failureStatusMin: number;
  forbiddenVisibleText: string;
};

function matchesRule(record: NetworkRecord, rule: UiApiConsistencyRule): boolean {
  return (
    record.method === rule.request.method &&
    normalizePathname(record.url) === rule.request.pathname &&
    typeof record.status === "number" &&
    record.status >= rule.failureStatusMin
  );
}

function key(record: NetworkRecord): string {
  return `${record.method} ${record.url} ${record.status}`;
}

/**
 * Generic, config-driven UI/API-consistency check: did a request matching
 * a configured rule newly fail (status >= failureStatusMin) while the
 * page's visible text still shows the rule's forbidden (success-implying)
 * text? Never hardcoded to any specific pathname or rule -- entirely
 * driven by oracles.uiApiConsistency.rules, so a new rule needs no code
 * change here.
 *
 * Deliberately registered FIRST in the oracle registry (see
 * buildOracleRegistry in oracles.ts): every violation this oracle detects
 * is *also* an http-failure (same >=500 status fact underneath), and
 * EVALUATE stops at the first suspicious oracle per action -- if
 * http-failure were checked first it would always win and this oracle
 * could never fire.
 */
export function createUiApiConsistencyOracle(config: AppConfig): Oracle {
  const rules = config.oracles.uiApiConsistency.rules;

  return {
    id: "ui-api-consistency",
    // eslint-disable-next-line @typescript-eslint/require-await
    async evaluate(before: Observation, _action, after: Observation): Promise<OracleResult> {
      for (const rule of rules) {
        const beforeMatches = before.networkRequests.filter((r) => matchesRule(r, rule));
        const afterMatches = after.networkRequests.filter((r) => matchesRule(r, rule));
        const newFailures = newItemsByKey(beforeMatches, afterMatches, key);
        if (newFailures.length === 0) continue;

        const showsForbiddenText = after.visibleText.includes(rule.forbiddenVisibleText);
        if (!showsForbiddenText) continue;

        return {
          oracleId: "ui-api-consistency",
          suspicious: true,
          expected: `UI should not display "${rule.forbiddenVisibleText}" when ${rule.request.method} ${rule.request.pathname} fails with HTTP >= ${rule.failureStatusMin}`,
          actual: `UI displays "${rule.forbiddenVisibleText}" despite a new HTTP ${newFailures[0]?.status} response from ${rule.request.method} ${rule.request.pathname}`,
          details: {
            ruleId: rule.id,
            newFailures: newFailures.map((r) => ({ method: r.method, url: r.url, status: r.status })),
          },
        };
      }

      return {
        oracleId: "ui-api-consistency",
        suspicious: false,
        expected:
          rules.length > 0
            ? "UI text stays consistent with API failure status for every configured rule"
            : "No ui-api-consistency rules configured",
        actual: "No configured rule was violated",
      };
    },
  };
}
