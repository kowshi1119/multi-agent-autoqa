import type { GroundTruthDefect } from "../reporting/benchmark.js";
import type { Finding } from "../types.js";
import type { AgreementResult, HumanReviewImport, HumanReviewLabel } from "./types.js";

export class HumanReviewImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanReviewImportError";
  }
}

const VALID_VERDICTS = new Set(["defect", "not-defect", "unsure"]);

function isLabel(value: unknown): value is HumanReviewLabel {
  if (!value || typeof value !== "object") return false;
  const l = value as Record<string, unknown>;
  return (
    typeof l["itemId"] === "string" &&
    typeof l["raterId"] === "string" &&
    typeof l["verdict"] === "string" &&
    VALID_VERDICTS.has(l["verdict"] as string) &&
    typeof l["labeledAt"] === "string"
  );
}

/** Schema-validated import -- rejects malformed label files with a specific reason rather than silently dropping bad entries. */
export function importLabels(raw: unknown): HumanReviewImport {
  if (!raw || typeof raw !== "object") {
    throw new HumanReviewImportError("HUMAN_REVIEW_IMPORT_ERROR: top-level value must be an object");
  }
  const value = raw as Record<string, unknown>;
  if (value["schemaVersion"] !== 1) {
    throw new HumanReviewImportError(`HUMAN_REVIEW_IMPORT_ERROR: unsupported schemaVersion ${String(value["schemaVersion"])}`);
  }
  if (typeof value["exportId"] !== "string") {
    throw new HumanReviewImportError("HUMAN_REVIEW_IMPORT_ERROR: exportId must be a string");
  }
  if (!Array.isArray(value["labels"]) || !value["labels"].every(isLabel)) {
    throw new HumanReviewImportError("HUMAN_REVIEW_IMPORT_ERROR: labels must be an array of well-formed HumanReviewLabel entries");
  }
  return { schemaVersion: 1, exportId: value["exportId"], labels: value["labels"] as HumanReviewLabel[] };
}

function pairwiseAgreementRate(labelsByItem: Map<string, HumanReviewLabel[]>): number | undefined {
  let agreeingPairs = 0;
  let totalPairs = 0;
  for (const labels of labelsByItem.values()) {
    if (labels.length < 2) continue;
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        totalPairs += 1;
        if (labels[i]!.verdict === labels[j]!.verdict) agreeingPairs += 1;
      }
    }
  }
  return totalPairs === 0 ? undefined : agreeingPairs / totalPairs;
}

/**
 * Computes agreement only from actual independent human labels -- returns
 * `{status:"unavailable"}` (never a fabricated number) when no labels
 * were imported, or when none of them map to a known item/finding.
 * Negative/inconclusive agreement values are valid outcomes, passed
 * through as-is; this function never tunes, discards inconvenient labels,
 * or requires a minimum score to report "computed".
 */
export function computeAgreement(
  imported: HumanReviewImport,
  itemIdToFindingId: Record<string, string>,
  groundTruth: GroundTruthDefect[],
  findingsById: Record<string, Finding>
): AgreementResult {
  if (imported.labels.length === 0) {
    return { status: "unavailable", reason: "no independent human labels imported" };
  }

  let agree = 0;
  let total = 0;
  const labelsByItem = new Map<string, HumanReviewLabel[]>();

  for (const label of imported.labels) {
    const findingId = itemIdToFindingId[label.itemId];
    const finding = findingId ? findingsById[findingId] : undefined;
    if (!finding) continue;

    const isActualDefect = groundTruth.some((g) => g.oracleId === finding.oracle.oracleId && g.pathname === finding.pathname);
    const raterSaysDefect = label.verdict === "defect";
    total += 1;
    if (isActualDefect === raterSaysDefect) agree += 1;

    const forItem = labelsByItem.get(label.itemId) ?? [];
    forItem.push(label);
    labelsByItem.set(label.itemId, forItem);
  }

  if (total === 0) {
    return { status: "unavailable", reason: "no imported labels matched a known item/finding mapping" };
  }

  const raterCount = new Set(imported.labels.map((l) => l.raterId)).size;
  const interRaterAgreement = pairwiseAgreementRate(labelsByItem);

  return {
    status: "computed",
    raterCount,
    itemCount: labelsByItem.size,
    agreementWithGroundTruth: agree / total,
    ...(interRaterAgreement !== undefined ? { interRaterAgreement } : {}),
  };
}
