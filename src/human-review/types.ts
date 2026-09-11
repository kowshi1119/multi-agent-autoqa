export type HumanReviewSchemaVersion = 1;

export type HumanReviewFindingSummary = {
  title: string;
  category: string;
  pathname: string;
  expected: string;
  actual: string;
  evidenceReferences: string[];
};

/** `itemId` is opaque (a random UUID, never derived from the finding id) so a rater cannot look anything up from it. Ground truth, critic verdict, and reportDisposition are deliberately absent -- the blinding this export exists to provide. */
export type HumanReviewItem = {
  itemId: string;
  findingSummary: HumanReviewFindingSummary;
};

export type HumanReviewExport = {
  schemaVersion: HumanReviewSchemaVersion;
  exportId: string;
  createdAt: string;
  items: HumanReviewItem[];
};

export type HumanReviewLabel = {
  itemId: string;
  raterId: string;
  verdict: "defect" | "not-defect" | "unsure";
  notes?: string;
  labeledAt: string;
};

export type HumanReviewImport = {
  schemaVersion: HumanReviewSchemaVersion;
  exportId: string;
  labels: HumanReviewLabel[];
};

/**
 * The mapping file now carries its own exportId (Phase 4 Milestone D2) so
 * import-cli.ts can reject a label file being applied against a mapping
 * from a DIFFERENT export -- previously the mapping was a bare
 * Record<string,string> with nothing to check a label file's exportId
 * against.
 */
export type HumanReviewMapping = {
  schemaVersion: HumanReviewSchemaVersion;
  exportId: string;
  itemIdToFindingId: Record<string, string>;
};

export type AgreementResult =
  | {
      status: "computed";
      raterCount: number;
      itemCount: number;
      /** Denominator for agreementWithGroundTruth -- items with a defect/not-defect verdict only; "unsure" is an abstention, excluded here, never folded into "not-defect". */
      itemsWithVerdict: number;
      /** Count of "unsure" verdicts among items that resolved to a known finding -- reported separately, never silently scored as agreement or disagreement. */
      abstentions: number;
      /** Absent when no ground truth was supplied for this dataset -- "no ground truth" is a distinct, honest state from "0% agreement", never conflated. */
      agreementWithGroundTruth?: number;
      interRaterAgreement?: number;
    }
  | { status: "unavailable"; reason: string };
