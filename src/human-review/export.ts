import { randomUUID } from "node:crypto";
import type { Finding } from "../types.js";
import type { HumanReviewExport, HumanReviewItem } from "./types.js";

/**
 * Builds a blind review export: opaque itemIds (random UUIDs, never
 * derived from the finding id) so a rater cannot look anything up, and a
 * SEPARATE itemId-to-findingId mapping the rater never sees. Ground
 * truth, critic verdict, and reportDisposition are deliberately excluded
 * from HumanReviewItem -- that's the actual blinding target; oracleId is
 * kept, since it's part of what's being judged, not an answer.
 */
export function exportForBlindReview(
  findings: Finding[],
  exportId: string = randomUUID()
): { export: HumanReviewExport; itemIdToFindingId: Record<string, string> } {
  const items: HumanReviewItem[] = [];
  const itemIdToFindingId: Record<string, string> = {};

  for (const finding of findings) {
    const itemId = randomUUID();
    itemIdToFindingId[itemId] = finding.id;
    items.push({
      itemId,
      findingSummary: {
        title: finding.title,
        category: finding.category,
        pathname: finding.pathname,
        expected: finding.expected,
        actual: finding.actual,
        evidenceReferences: finding.evidence,
      },
    });
  }

  return {
    export: { schemaVersion: 1, exportId, createdAt: new Date().toISOString(), items },
    itemIdToFindingId,
  };
}
