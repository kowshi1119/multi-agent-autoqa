import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule } from "../main-module-guard.js";
import { loadGroundTruth, type GroundTruthDefect } from "../reporting/benchmark.js";
import type { Finding } from "../types.js";
import { computeAgreement, HumanReviewImportError, importLabels, importMapping, validateLabelsAgainstMapping } from "./import.js";

function main(): void {
  const args = process.argv.slice(2);
  const labelsFlag = args.indexOf("--labels");
  const mappingFlag = args.indexOf("--mapping");
  const reportFlag = args.indexOf("--report");
  const groundTruthFlag = args.indexOf("--ground-truth");
  const noGroundTruth = args.includes("--no-ground-truth");

  if (labelsFlag === -1 || mappingFlag === -1 || reportFlag === -1) {
    console.error(
      "Usage: npm run human-review:import -- --labels <path> --mapping <path> --report <path to report.json> [--ground-truth <path> | --no-ground-truth]"
    );
    process.exitCode = 1;
    return;
  }
  if (groundTruthFlag !== -1 && noGroundTruth) {
    console.error("HUMAN_REVIEW_IMPORT_ERROR: --ground-truth and --no-ground-truth are mutually exclusive");
    process.exitCode = 1;
    return;
  }

  try {
    const imported = importLabels(JSON.parse(readFileSync(resolve(args[labelsFlag + 1] as string), "utf-8")));
    const mapping = importMapping(JSON.parse(readFileSync(resolve(args[mappingFlag + 1] as string), "utf-8")));
    const { dedupedLabels } = validateLabelsAgainstMapping(imported, mapping);

    const report = JSON.parse(readFileSync(resolve(args[reportFlag + 1] as string), "utf-8")) as { findings: Finding[] };
    const findingsById: Record<string, Finding> = Object.fromEntries(report.findings.map((f) => [f.id, f]));

    // Ground truth is now explicitly optional and dataset-specific --
    // never a hardcoded fallback to the fixture's own answer key. Absence
    // (--no-ground-truth, or neither flag given for a dataset with no
    // known answer key) means no agreement-with-ground-truth score, a
    // distinct, honest state from "0% agreement".
    let groundTruth: GroundTruthDefect[] | undefined;
    if (groundTruthFlag !== -1) {
      groundTruth = loadGroundTruth(resolve(args[groundTruthFlag + 1] as string)).defects;
    } else if (!noGroundTruth) {
      console.error(
        "HUMAN_REVIEW_IMPORT_ERROR: specify --ground-truth <path> (for a dataset with a known answer key, e.g. the local fixture) or --no-ground-truth (for a real-target dataset with none) explicitly."
      );
      process.exitCode = 1;
      return;
    }

    const result = computeAgreement({ ...imported, labels: dedupedLabels }, mapping.itemIdToFindingId, groundTruth, findingsById);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof HumanReviewImportError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (isMainModule(import.meta.url)) main();
