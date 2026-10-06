import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { changedFilesFromPorcelain, newVerificationId, playwrightBrowser, runStages } from "./verify-runner.mjs";

// Run via npm so its actual CLI path is known on Windows and Unix.
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run npm run verify:local from the project directory.");
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/API_KEY|^QA_(USERNAME|PASSWORD)$|^OLLAMA_/i.test(key)) delete env[key];
}
// dotenv/config must not repopulate local credentials removed above.
env.DOTENV_CONFIG_PATH = resolve("scripts", ".verification-no-env");
env.DOTENV_CONFIG_QUIET = "true";

const npmStage = (name, args, extra = {}) => ({ name, command: process.execPath, args: [npm, ...args], display: `npm ${args.join(" ")}`, ...extra });
const stages = [
  npmStage("typecheck", ["run", "typecheck"]),
  npmStage("build", ["run", "build"]),
  // Keep the complete suite; cap workers instead of relaxing assertions
  // or timeouts on the documented four-core development machine.
  npmStage("test", ["test", "--", "--maxWorkers=2"], { countTests: true }),
  npmStage("challenge-corpus", ["run", "challenge-corpus:validate"]),
];

// Source identity: commit plus the NAMES of changed files (never their contents).
// Compared again at the end: a run whose source changed while it ran (for
// example, a file saved during the test stage) does not verify any one source.
const git = (args) => {
  const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout : null;
};
const sourceState = () => ({ commit: git(["rev-parse", "HEAD"])?.trim() ?? null, changedFiles: changedFilesFromPorcelain(git(["status", "--porcelain", "--untracked-files=all"]) ?? "").filter((f) => !f.startsWith("verification/")) });
const require = createRequire(import.meta.url);
const versionOf = (pkg) => { try { return require(`${pkg}/package.json`).version; } catch { return null; } };
const browser = playwrightBrowser((id) => require.resolve(id));
const npmVersion = spawnSync(process.execPath, [npm, "--version"], { encoding: "utf8", windowsHide: true, env }).stdout?.trim() ?? null;

const id = newVerificationId();
const outDir = join(resolve("verification"), id);
const before = sourceState();
const summary = await runStages({
  stages,
  outDir,
  env,
  handleSignals: true,
  meta: {
    verificationId: id,
    source: before,
    versions: { node: process.version, npm: npmVersion, vitest: versionOf("vitest"), playwright: versionOf("playwright"), typescript: versionOf("typescript"), browser },
    note: "Environment variable values are not recorded. Credential-like variables are removed before any stage runs.",
  },
});
const after = sourceState();
const sourceChanged = after.commit !== before.commit || JSON.stringify(after.changedFiles) !== JSON.stringify(before.changedFiles);
if (sourceChanged) {
  summary.sourceChangedDuringRun = { before, after };
  summary.verifiedSource = null;
} else {
  summary.verifiedSource = summary.state === "passed" ? before : null;
}
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

for (const stage of summary.stages) {
  const counts = stage.counts?.tests ? ` (${stage.counts.tests.passed} passed, ${stage.counts.tests.failed} failed of ${stage.counts.tests.total} tests)` : "";
  console.log(`[${id}] ${stage.name}: ${stage.state}${stage.durationMs !== undefined ? ` in ${Math.round(stage.durationMs / 1000)} s` : ""}${counts}`);
}
if (summary.state !== "passed") {
  const failing = summary.stages.find((s) => s.name === summary.firstFailingStage);
  console.error(`Local verification ${summary.state} at stage "${summary.firstFailingStage}"${failing?.launchError ? ` (could not start: ${failing.launchError})` : failing?.exitCode !== undefined && failing?.exitCode !== null ? ` (exit ${failing.exitCode})` : failing?.signal ? ` (signal ${failing.signal})` : ""}. Log: ${failing?.log ?? "none"}. Summary: ${join(outDir, "summary.json")}`);
  process.exit(summary.exitCode ?? 1);
}
if (sourceChanged) {
  console.error(`Every stage passed, but the source changed while verification ran, so no single source is verified. Re-run on an unchanged working tree. Summary: ${join(outDir, "summary.json")}`);
  process.exit(3);
}
console.log(`Local verification passed (${id}). Summary: ${join(outDir, "summary.json")}. No real model or authenticated application acceptance is implied.`);
