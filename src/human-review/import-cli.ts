import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule } from "../main-module-guard.js";
import { loadGroundTruth } from "../reporting/benchmark.js";
import type { Finding } from "../types.js";
import { computeAgreement, importLabels } from "./import.js";

function main(): void {
  const args = process.argv.slice(2);
  const labelsFlag = args.indexOf("--labels");
  const mappingFlag = args.indexOf("--mapping");
  const reportFlag = args.indexOf("--report");
  if (labelsFlag === -1 || mappingFlag === -1 || reportFlag === -1) {
    console.error("Usage: npm run human-review:import -- --labels <path> --mapping <path> --report <path to report.json>");
    process.exitCode = 1;
    return;
  }

  const imported = importLabels(JSON.parse(readFileSync(resolve(args[labelsFlag + 1] as string), "utf-8")));
  const itemIdToFindingId = JSON.parse(readFileSync(resolve(args[mappingFlag + 1] as string), "utf-8")) as Record<string, string>;
  const report = JSON.parse(readFileSync(resolve(args[reportFlag + 1] as string), "utf-8")) as { findings: Finding[] };
  const findingsById: Record<string, Finding> = Object.fromEntries(report.findings.map((f) => [f.id, f]));
  const groundTruth = loadGroundTruth(resolve("fixture", "ground-truth.json")).defects;

  const result = computeAgreement(imported, itemIdToFindingId, groundTruth, findingsById);
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) main();
