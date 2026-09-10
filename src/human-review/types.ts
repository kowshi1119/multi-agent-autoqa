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

export type AgreementResult =
  | {
      status: "computed";
      raterCount: number;
      itemCount: number;
      agreementWithGroundTruth: number;
      interRaterAgreement?: number;
    }
  | { status: "unavailable"; reason: string };
