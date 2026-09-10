import type { FindingStatus, ReportDisposition } from "../types.js";

export type GroupingVersion = 1;

/**
 * A structural fingerprint of a finding's underlying failure. `actionContext`
 * (the triggering control) is captured for disclosure but deliberately
 * excluded from the merge-equality key (see fingerprint.ts#fingerprintKey)
 * -- the same underlying defect reached via two different controls is
 * exactly the "same failure through different controls" case grouping
 * exists to consolidate, and requiring actionContext equality would make
 * that case ungroupable by construction.
 */
export type FindingFingerprint = {
  oracleId: string;
  appScope: string;
  failurePredicate: string;
  requestMethod?: string;
  requestEndpoint?: string;
  errorSignature: string;
  actionContext: string;
  requirementScope?: string;
};

export type FindingGroupMemberStat = {
  findingId: string;
  status: FindingStatus;
  reportDisposition: ReportDisposition;
  occurrenceCount: number;
  reproduction: { attempts: number; successes: number };
};

export type FindingGroup = {
  groupId: string;
  groupingVersion: GroupingVersion;
  canonicalFindingId: string;
  memberFindingIds: string[];
  reason: string;
  ruleId: "same-fingerprint";
  evidenceReferences: string[];
  dispositionConflict: boolean;
  memberStats: FindingGroupMemberStat[];
};

export type PossibleRelationship = {
  findingIds: string[];
  note: string;
};

export type GroupingResult = {
  groupingVersion: GroupingVersion;
  enabled: boolean;
  groups: FindingGroup[];
  /** Finding ids that were not merged into any group -- includes every finding when grouping is disabled. */
  ungrouped: string[];
  possibleRelationships: PossibleRelationship[];
};
