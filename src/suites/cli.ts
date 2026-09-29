import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveTransientCredentials } from "../auth/session-bootstrap.js";
import { isMainModule } from "../main-module-guard.js";
import { assertExpectedTarget, TargetChangedError, targetIdentity } from "../profiles/fingerprint.js";
import { ProfileStore } from "../profiles/store.js";
import { credentialSecrets, redactSecrets } from "../redact.js";
import { PreflightFailedError, RunAlreadyActiveError, RunManager, SuiteInvalidError } from "../run-manager.js";
import type { SuiteComparison } from "./compare.js";
import { readSuiteResult, type SuiteResult } from "./result.js";
import { findSuite, SuiteError, validateSuite } from "./suite-manifest.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `npm run suite -- --profile <id> --suite <id> [--json <file>]`
 *
 * Runs a saved regression suite through the same RunManager.startRun() path
 * the UI uses (locks, target binding, cancellation, authentication, budgets).
 * Credentials are never accepted as arguments: a sign-in profile reads them
 * from the existing QA_USERNAME / QA_PASSWORD environment input, and without
 * them the run is refused before anything is contacted. No browser session
 * is ever persisted. Mock providers only (demo mode): declared workflows and
 * checks need no model.
 *
 * Exit codes: 0 PASS · 1 FAIL · 2 INCOMPLETE · 3 rejected before execution · 4 internal error.
 */
export const EXIT = { PASS: 0, FAIL: 1, INCOMPLETE: 2, REJECTED: 3, ERROR: 4 } as const;

export type CliIo = { out: (line: string) => void; err: (line: string) => void; env: NodeJS.ProcessEnv; onInterrupt?: (stop: () => void) => void };

const USAGE = "Usage: npm run suite -- --profile <id> --suite <id> [--json <file>] [--profiles-dir <dir>] [--runs-dir <dir>]";
const ALLOWED_FLAGS = new Set(["--profile", "--suite", "--json", "--profiles-dir", "--runs-dir"]);

function parseArgs(argv: string[]): { ok: true; values: Record<string, string> } | { ok: false; message: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string;
    if (/pass|token|secret|cookie|credential|auth/i.test(flag)) return { ok: false, message: "Credentials and tokens are never accepted as command-line arguments. Set QA_USERNAME and QA_PASSWORD in the environment for a sign-in profile." };
    if (!ALLOWED_FLAGS.has(flag)) return { ok: false, message: `Unknown option ${flag}. ${USAGE}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, message: `Missing value for ${flag}. ${USAGE}` };
    values[flag.slice(2)] = value;
  }
  if (!values["profile"] || !values["suite"]) return { ok: false, message: USAGE };
  return { ok: true, values };
}

export type CliJson = {
  schemaVersion: 1;
  runId: string;
  profileId: string;
  suite: { id: string; name: string; revision: number };
  target: SuiteResult["target"];
  decision: SuiteResult["decision"];
  decisionReason: string;
  scope: string;
  coverageGaps: SuiteResult["coverageGaps"];
  counts: SuiteResult["counts"];
  comparison: { comparable: boolean; reason?: string; baselineRunId: string | null; counts: SuiteComparison["counts"] | null; newlyFailing: Array<{ identity: string; expected?: string; observed?: string; evidenceRefs: string[] }> };
  accounting: SuiteResult["accounting"];
  artifacts: string;
};

export function toCliJson(result: SuiteResult, comparison: SuiteComparison | undefined, runDir: string): CliJson {
  return {
    schemaVersion: 1,
    runId: result.runId,
    profileId: result.profileId,
    suite: { id: result.suite.id, name: result.suite.name, revision: result.suite.revision },
    target: result.target,
    decision: result.decision,
    decisionReason: result.decisionReason,
    scope: result.scope,
    coverageGaps: result.coverageGaps,
    counts: result.counts,
    comparison: {
      comparable: comparison?.comparable ?? false,
      ...(comparison?.reason ? { reason: comparison.reason } : {}),
      baselineRunId: comparison?.baseline?.runId ?? null,
      counts: comparison?.comparable ? comparison.counts : null,
      newlyFailing: (comparison?.entries ?? []).filter((e) => e.category === "newly-failing").map((e) => ({ identity: e.identity, ...(e.expected ? { expected: e.expected } : {}), ...(e.observed ? { observed: e.observed } : {}), evidenceRefs: e.evidenceRefs })),
    },
    accounting: result.accounting,
    artifacts: runDir,
  };
}

function summaryLines(json: CliJson): string[] {
  const lines = [
    `Suite ${json.suite.name} (rev ${json.suite.revision}) on ${json.target.origin} [${json.target.environmentKind}] — run ${json.runId}`,
    `Decision: ${json.decision} — ${json.decisionReason}`,
    `Items: ${json.counts.passed} passed, ${json.counts.failed} failed, ${json.counts.notExecuted} not executed, ${json.counts.unsupported} unsupported (${json.counts.required} required, ${json.counts.optional} optional).`,
  ];
  for (const gap of json.coverageGaps) lines.push(`  Coverage gap: ${gap.identity} (${gap.status}) — ${gap.reason}`);
  if (json.comparison.comparable && json.comparison.counts) {
    const c = json.comparison.counts;
    lines.push(`Compared with baseline ${json.comparison.baselineRunId}: ${c["newly-failing"]} newly failing, ${c["still-failing"]} still failing, ${c.fixed} fixed, ${c["unchanged-passing"]} unchanged passing, ${c["not-executed"]} not executed, ${c.unsupported} unsupported, ${c.incomparable} incomparable, ${c.added} added, ${c.removed} removed.`);
    for (const f of json.comparison.newlyFailing) lines.push(`  Newly failing: ${f.identity} — expected ${f.expected ?? "?"}, observed ${f.observed ?? "?"}`);
  } else {
    lines.push(`Comparison: ${json.comparison.reason ?? "unavailable"}`);
  }
  lines.push(`Usage: ${json.accounting.browserActions} browser actions · ${json.accounting.httpCheckRequests} HTTP check requests · ${json.accounting.modelDecisions} model decisions · ${json.accounting.externalModelRequests} external model requests.`);
  lines.push(json.scope);
  return lines;
}

export async function runSuiteCli(argv: string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) { io.err(parsed.message); return EXIT.REJECTED; }
  const { profile: profileId, suite: suiteId } = parsed.values as { profile: string; suite: string };
  const store = new ProfileStore(resolve(parsed.values["profiles-dir"] ?? "profiles"));
  const runsDir = resolve(parsed.values["runs-dir"] ?? "runs");
  const manager = new RunManager(store, runsDir);

  let secrets: readonly string[] = [];
  try {
    const profile = store.load(profileId);
    const suite = findSuite(store.getDir(), profileId, suiteId);
    const validation = validateSuite(store, profileId, suite);
    if (!validation.ok) { io.err(`Suite rejected before execution; nothing was contacted:\n  - ${validation.errors.join("\n  - ")}`); return EXIT.REJECTED; }
    // Existing environment input only (same variables as `npm run qa`); never argv, never stored.
    const credentials = profile.auth.mode === "form-login" ? resolveTransientCredentials(io.env) : undefined;
    if (profile.auth.mode === "form-login" && !credentials) {
      io.err("This application needs sign-in. Unattended authentication is not configured: set QA_USERNAME and QA_PASSWORD in the environment (never as arguments). Nothing was contacted.");
      return EXIT.REJECTED;
    }
    secrets = credentialSecrets(credentials);
    const expected = targetIdentity(store, profileId);
    assertExpectedTarget(store, profileId, { fingerprint: expected.fingerprint, origin: expected.origin });
    const { runId } = await manager.startRun({ profileId, suiteId, mode: "demo", ...(credentials ? { credentials } : {}), expected: { fingerprint: expected.fingerprint, origin: expected.origin } });
    io.onInterrupt?.(() => manager.stopRun(runId));
    io.out(`Started suite run ${runId}.`);
    while (manager.getActiveRun()?.runId === runId) await new Promise((r) => setTimeout(r, 200));
    const runDir = join(runsDir, runId);
    const result = readSuiteResult(runDir);
    if (!result) { io.err(`Run ${runId} finished without a suite result; see ${runDir}.`); return EXIT.ERROR; }
    const comparisonPath = join(runDir, "suite-comparison.json");
    const comparison = existsSync(comparisonPath) ? JSON.parse(readFileSync(comparisonPath, "utf-8")) as SuiteComparison : undefined;
    const json = toCliJson(result, comparison, runDir);
    for (const line of summaryLines(json)) io.out(redactSecrets(line, secrets));
    if (parsed.values["json"]) writeFileSync(resolve(parsed.values["json"]), redactSecrets(JSON.stringify(json, null, 2), secrets), "utf-8");
    return result.decision === "PASS" ? EXIT.PASS : result.decision === "FAIL" ? EXIT.FAIL : EXIT.INCOMPLETE;
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    if (error instanceof SuiteInvalidError || error instanceof SuiteError || error instanceof TargetChangedError || error instanceof PreflightFailedError || error instanceof RunAlreadyActiveError || (error instanceof Error && error.name === "ProfileError")) {
      io.err(`Rejected before execution: ${message}`);
      return EXIT.REJECTED;
    }
    io.err(`Internal error: ${message}`);
    return EXIT.ERROR;
  }
}

if (isMainModule(import.meta.url)) {
  runSuiteCli(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    env: process.env,
    onInterrupt: (stop) => process.once("SIGINT", () => { console.error("Stop requested; waiting for the run to end."); stop(); }),
  }).then((code) => { process.exitCode = code; }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT.ERROR;
  });
}
