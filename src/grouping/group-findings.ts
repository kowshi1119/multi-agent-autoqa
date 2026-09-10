import { createHash } from "node:crypto";
import type { Finding } from "../types.js";
import { fingerprintFinding, fingerprintKey } from "./fingerprint.js";
import type { FindingGroup, FindingGroupMemberStat, GroupingResult, GroupingVersion } from "./types.js";

const GROUPING_VERSION: GroupingVersion = 1;

const DISPOSITION_RANK: Record<string, number> = { report: 0, needs_human: 1, suppress: 2 };

function stableGroupId(memberIds: string[]): string {
  const sorted = [...memberIds].sort();
  const hash = createHash("sha256").update(`${GROUPING_VERSION}|${sorted.join(",")}`).digest("hex");
  return `GROUP-${hash.slice(0, 12)}`;
}

/**
 * Deterministic representative: a suppressed/uncertain member must never
 * hide a reportable one, so "report" always outranks "needs_human"/
 * "suppress" regardless of arrival order; ties break on stronger
 * reproduction, then lowest (earliest-created) finding id.
 */
function pickCanonical(members: Finding[]): Finding {
  const sorted = [...members].sort((a, b) => {
    const rankDiff = (DISPOSITION_RANK[a.reportDisposition] ?? 1) - (DISPOSITION_RANK[b.reportDisposition] ?? 1);
    if (rankDiff !== 0) return rankDiff;
    const successDiff = b.reproduction.successes - a.reproduction.successes;
    if (successDiff !== 0) return successDiff;
    return a.id.localeCompare(b.id);
  });
  return sorted[0] as Finding;
}

function memberStatsOf(finding: Finding): FindingGroupMemberStat {
  return {
    findingId: finding.id,
    status: finding.status,
    reportDisposition: finding.reportDisposition,
    occurrenceCount: finding.occurrenceCount,
    reproduction: { ...finding.reproduction },
  };
}

/** A finding with zero persisted evidence files has nothing reliable to fingerprint against -- never force a merge decision on missing evidence. */
function hasSufficientEvidence(finding: Finding): boolean {
  return finding.evidence.length > 0;
}

/**
 * Deterministic, idempotent, order-independent cross-finding grouping.
 * Runs on already-reviewed (post-disposition) findings, strictly after
 * the existing per-finding dedup key and per-finding critic review --
 * never replaces or folds into either. Groups are described as
 * evidence-supported duplicate manifestations, never proven root causes.
 * Never fabricates a stronger reproduction rate: memberStats preserves
 * each member's own numbers verbatim, and no aggregate/summed statistic
 * is ever computed across a group.
 */
export function groupFindings(findings: Finding[], config: { enabled: boolean }): GroupingResult {
  if (!config.enabled) {
    return {
      groupingVersion: GROUPING_VERSION,
      enabled: false,
      groups: [],
      ungrouped: findings.map((f) => f.id),
      possibleRelationships: [],
    };
  }

  const eligible = findings.filter(hasSufficientEvidence);
  const buckets = new Map<string, Finding[]>();
  for (const finding of eligible) {
    const key = fingerprintKey(fingerprintFinding(finding));
    const bucket = buckets.get(key) ?? [];
    bucket.push(finding);
    buckets.set(key, bucket);
  }

  const groupedIds = new Set<string>();
  const groups: FindingGroup[] = [];
  const singletons: Finding[] = [];

  // Sort bucket keys themselves so group construction order (and thus
  // groupId derivation, which only depends on member ids, is unaffected,
  // but iteration itself) never depends on Map insertion order.
  const sortedKeys = [...buckets.keys()].sort();
  for (const key of sortedKeys) {
    const members = buckets.get(key) as Finding[];
    if (members.length < 2) {
      singletons.push(...members);
      continue;
    }

    const sortedMembers = [...members].sort((a, b) => a.id.localeCompare(b.id));
    const memberIds = sortedMembers.map((m) => m.id);
    const canonical = pickCanonical(sortedMembers);
    const dispositions = new Set(sortedMembers.map((m) => m.reportDisposition));

    groups.push({
      groupId: stableGroupId(memberIds),
      groupingVersion: GROUPING_VERSION,
      canonicalFindingId: canonical.id,
      memberFindingIds: memberIds,
      reason: `${memberIds.length} findings share the same oracle/endpoint/error fingerprint at ${canonical.pathname} -- evidence-supported duplicate manifestations of the same underlying defect, not a proven single root cause.`,
      ruleId: "same-fingerprint",
      evidenceReferences: [...new Set(sortedMembers.flatMap((m) => m.evidence))],
      dispositionConflict: dispositions.size > 1,
      memberStats: sortedMembers.map(memberStatsOf),
    });
    for (const id of memberIds) groupedIds.add(id);
  }

  // Optional, best-effort: singleton findings sharing an oracle+page but a
  // different fingerprint are recorded as a possible relationship rather
  // than silently ignored -- never merged, just surfaced for a human to
  // judge, since the evidence alone doesn't structurally justify a merge.
  const possibleRelationships: GroupingResult["possibleRelationships"] = [];
  for (let i = 0; i < singletons.length; i += 1) {
    for (let j = i + 1; j < singletons.length; j += 1) {
      const a = singletons[i] as Finding;
      const b = singletons[j] as Finding;
      if (a.oracle.oracleId === b.oracle.oracleId && a.pathname === b.pathname) {
        possibleRelationships.push({
          findingIds: [a.id, b.id].sort(),
          note: `Same oracle (${a.oracle.oracleId}) and page (${a.pathname}) but a different failure signature -- kept separate; may be worth a human look for a shared root cause.`,
        });
      }
    }
  }

  const ungrouped = findings.filter((f) => !groupedIds.has(f.id)).map((f) => f.id);

  return { groupingVersion: GROUPING_VERSION, enabled: true, groups, ungrouped, possibleRelationships };
}
