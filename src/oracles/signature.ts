import { normalizePathname } from "../mapping/state-signature.js";
import { normalizedActual } from "../reporting/dedup.js";
import type { OracleResult } from "../types.js";

type NetworkFailureLike = { method: string; url: string; status?: number };

function networkTuple(f: NetworkFailureLike): string {
  return `${f.method}|${normalizePathname(f.url)}|${f.status ?? ""}`;
}

/**
 * A stable structural fingerprint of WHICH failure an OracleResult
 * represents -- oracleId plus a normalized, order-independent projection
 * of `details`, deliberately NOT full narrative (expected/actual string)
 * equality (incidental prose differences must never split one failure
 * into two) and NOT raw `details` equality either (volatile fields, like
 * duplicate-request's `newCount`, must not do the same in reverse: the
 * exact count varies run to run and is not part of "which failure").
 *
 * Falls back to oracleId + reporting/dedup.ts#normalizedActual(actual) for
 * any oracle id without a registered extractor below -- same conservative
 * fallback idiom as critic/evidence-level.ts's unknown-oracle handling.
 */
export function oracleFailureSignature(result: OracleResult): string {
  const details = result.details as Record<string, unknown> | undefined;

  if (result.oracleId === "http-failure" || result.oracleId === "ui-api-consistency") {
    const newFailures = (details?.["newFailures"] as NetworkFailureLike[] | undefined) ?? [];
    const ruleId = result.oracleId === "ui-api-consistency" ? String(details?.["ruleId"] ?? "") : "";
    const tuples = newFailures.map(networkTuple).sort();
    return `${result.oracleId}|${ruleId}|${tuples.join(",")}`;
  }

  if (result.oracleId === "duplicate-request") {
    const violations = (details?.["violations"] as Array<{ method: string; pathname: string }> | undefined) ?? [];
    const tuples = violations.map((v) => `${v.method}|${v.pathname}`).sort();
    return `${result.oracleId}|${tuples.join(",")}`;
  }

  if (result.oracleId === "console-error" || result.oracleId === "page-error") {
    const newErrors = (details?.["newErrors"] as string[] | undefined) ?? [];
    const normalized = newErrors.map((e) => normalizedActual(e)).sort();
    return `${result.oracleId}|${normalized.join(",")}`;
  }

  return `${result.oracleId}|${normalizedActual(result.actual)}`;
}

/** Same oracle AND the same structural fingerprint -- what "reproduces the ORIGINAL finding" means, as opposed to "this oracle fired again on something." */
export function sameFailure(a: OracleResult, b: OracleResult): boolean {
  if (a.oracleId !== b.oracleId) return false;
  return oracleFailureSignature(a) === oracleFailureSignature(b);
}
