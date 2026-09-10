import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMainModule } from "../main-module-guard.js";
import { redactSecrets } from "../redact.js";
import type { Finding } from "../types.js";
import { exportForBlindReview } from "./export.js";

function main(): void {
  const args = process.argv.slice(2);
  const reportFlag = args.indexOf("--report");
  const outFlag = args.indexOf("--out");
  if (reportFlag === -1 || outFlag === -1) {
    console.error("Usage: npm run human-review:export -- --report <path to report.json> --out <output dir>");
    process.exitCode = 1;
    return;
  }

  const reportPath = resolve(args[reportFlag + 1] as string);
  const outDir = resolve(args[outFlag + 1] as string);
  const report = JSON.parse(readFileSync(reportPath, "utf-8")) as { findings: Finding[] };

  const { export: blindExport, itemIdToFindingId } = exportForBlindReview(report.findings);

  mkdirSync(outDir, { recursive: true });
  const exportPath = join(outDir, "blind-review-export.json");
  const mappingPath = join(outDir, "item-mapping.json");
  writeFileSync(exportPath, redactSecrets(JSON.stringify(blindExport, null, 2)), "utf-8");
  writeFileSync(mappingPath, redactSecrets(JSON.stringify(itemIdToFindingId, null, 2)), "utf-8");

  console.log(`Exported ${blindExport.items.length} items for blind review.`);
  console.log(`Rater-facing file (share this): ${exportPath}`);
  console.log(`Mapping file (keep private -- never share with raters): ${mappingPath}`);
}

if (isMainModule(import.meta.url)) main();
