import { resolve } from "node:path";
import { isMainModule } from "../main-module-guard.js";
import { loadChallengeCorpus, validateChallengeCorpus } from "./challenge-corpus.js";

function main(): void {
  const path = resolve(process.argv[2] ?? "fixture/challenge-corpus/manifest.json");
  const manifest = loadChallengeCorpus(path);
  const errors = validateChallengeCorpus(manifest);

  const distinct = manifest.cases.filter((c) => c.label === "distinct-defect").length;
  const nonDefect = manifest.cases.filter((c) => c.label === "non-defect").length;
  const executable = manifest.cases.filter((c) => c.kind === "executable-fixture").length;
  const offline = manifest.cases.filter((c) => c.kind === "offline-evidence-record").length;

  console.log(`Challenge corpus: ${path}`);
  console.log(`Cases: ${manifest.cases.length} (${distinct} distinct-defect, ${nonDefect} non-defect, ${executable} executable-fixture, ${offline} offline-evidence-record)`);

  if (errors.length === 0) {
    console.log("VALID -- no issues found.");
    return;
  }

  console.error(`${errors.length} issue(s) found:`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main();
