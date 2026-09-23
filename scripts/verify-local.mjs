import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

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
const checks = [
  ["run", "typecheck"],
  ["run", "build"],
  // Keep the complete suite; cap workers instead of relaxing assertions
  // or timeouts on the documented four-core development machine.
  ["test", "--", "--maxWorkers=2"],
  ["run", "challenge-corpus:validate"],
];
for (const args of checks) {
  const result = spawnSync(process.execPath, [npm, ...args], { env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error("Local verification stopped at: npm " + args.join(" "));
    process.exit(result.status || 1);
  }
}
console.log("Local verification passed. No real model or authenticated application acceptance is implied.");
