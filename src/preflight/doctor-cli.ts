import "dotenv/config";
import { resolve } from "node:path";
import { createLogger } from "../logger.js";
import { isMainModule } from "../main-module-guard.js";
import { ProfileError } from "../profiles/schema.js";
import { ProfileStore } from "../profiles/store.js";
import { profileToAppConfig } from "../profiles/to-app-config.js";
import { runPreflight, schemaFailureReport, type PreflightReport } from "./doctor.js";

function parseArgs(argv: string[]): { profileId: string } {
  const flagIndex = argv.indexOf("--profile");
  const profileId = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  if (!profileId) {
    console.error("Usage: npm run doctor -- --profile <id>");
    process.exitCode = 1;
    process.exit(1);
  }
  return { profileId };
}

function printReport(report: PreflightReport): void {
  console.log(`\nAutoQA doctor -- profile "${report.profileId}"\n`);
  for (const check of report.checks) {
    const mark = check.status === "pass" ? "✓" : check.status === "skipped" ? "-" : "✗";
    console.log(`${mark} ${check.name}: ${check.detail}`);
    if (check.nextStep) console.log(`  Next step: ${check.nextStep}`);
  }
  console.log(`\nOverall: ${report.overallReady ? "READY" : "NOT READY"}\n`);
}

async function main(): Promise<void> {
  const { profileId } = parseArgs(process.argv.slice(2));
  const logger = createLogger();
  const store = new ProfileStore(resolve("profiles"));

  let report: PreflightReport;
  try {
    const profile = store.load(profileId);
    const config = profileToAppConfig(profile);
    report = await runPreflight(profile, config, logger);
  } catch (error) {
    if (error instanceof ProfileError) {
      report = schemaFailureReport(profileId, error.message);
    } else {
      throw error;
    }
  }

  printReport(report);
  process.exitCode = report.overallReady ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("AutoQA doctor encountered an unexpected error:");
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
