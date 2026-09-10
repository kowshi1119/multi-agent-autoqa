import { normalizePathname } from "../mapping/state-signature.js";
import { oracleFailureSignature } from "../oracles/signature.js";
import type { Finding } from "../types.js";
import type { FindingFingerprint } from "./types.js";

type NetworkFailureLike = { method: string; url: string };

function networkDetailsOf(finding: Finding): { method?: string; endpoint?: string } {
  const details = finding.oracle.details as Record<string, unknown> | undefined;
  const newFailures = details?.["newFailures"] as NetworkFailureLike[] | undefined;
  const first = newFailures?.[0];
  if (!first) return {};
  return { method: first.method, endpoint: normalizePathname(first.url) };
}

function failurePredicateOf(finding: Finding): string {
  if (finding.oracle.oracleId === "ui-api-consistency") {
    const details = finding.oracle.details as Record<string, unknown> | undefined;
    const ruleId = details?.["ruleId"];
    if (typeof ruleId === "string" && ruleId) return ruleId;
  }
  return finding.oracle.oracleId;
}

/**
 * A structural fingerprint of WHICH defect a finding represents --
 * application scope (pathname), the specific rule/predicate that fired
 * (a ui-api-consistency ruleId, or the oracleId itself for other oracles),
 * request method/endpoint when the oracle is network-shaped, the reused
 * failure signature from oracles/signature.ts (never full narrative-text
 * equality), and any requirement scope the critic already identified.
 * `actionContext` (the triggering controlKey) is recorded but excluded
 * from the merge key -- see FindingFingerprint's doc comment.
 */
export function fingerprintFinding(finding: Finding): FindingFingerprint {
  const { method, endpoint } = networkDetailsOf(finding);

  return {
    oracleId: finding.oracle.oracleId,
    appScope: finding.pathname,
    failurePredicate: failurePredicateOf(finding),
    ...(method ? { requestMethod: method } : {}),
    ...(endpoint ? { requestEndpoint: endpoint } : {}),
    errorSignature: oracleFailureSignature(finding.oracle),
    actionContext: finding.controlKey ?? "",
    ...(finding.critic?.requirementConflict ? { requirementScope: finding.critic.requirementConflict } : {}),
  };
}

/**
 * The merge-equality string: every field EXCEPT actionContext. Two
 * findings with the same key are evidence-supported duplicate
 * manifestations of the same underlying defect; a different key means a
 * meaningful difference (endpoint, error, requirement scope) was
 * preserved, and they stay separate findings.
 */
export function fingerprintKey(fp: FindingFingerprint): string {
  return [
    fp.oracleId,
    fp.appScope,
    fp.failurePredicate,
    fp.requestMethod ?? "",
    fp.requestEndpoint ?? "",
    fp.errorSignature,
    fp.requirementScope ?? "",
  ].join("|");
}
