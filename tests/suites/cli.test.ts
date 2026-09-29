import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { EXIT, runSuiteCli, type CliJson } from "../../src/suites/cli.js";
import { approveBaseline } from "../../src/suites/baselines.js";
import { readSuiteResult } from "../../src/suites/result.js";
import { findSuite, saveSuite, suiteContentHash } from "../../src/suites/suite-manifest.js";
import { credentials, suiteEnvironment } from "../helpers/suite-env.js";

let server: AuthFixtureServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

const env = { QA_USERNAME: credentials.username, QA_PASSWORD: credentials.password };
const totalHits = () => [...server!.hits.values()].reduce((a, b) => a + b, 0);

async function cli(args: string[], processEnv: NodeJS.ProcessEnv = env, stopImmediately = false) {
  const out: string[] = []; const err: string[] = [];
  const code = await runSuiteCli(args, { out: (l) => out.push(l), err: (l) => err.push(l), env: processEnv, ...(stopImmediately ? { onInterrupt: (stop: () => void) => stop() } : {}) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("suite CLI", () => {
  it("rejects credential arguments, unknown suites and missing unattended credentials before contacting anything", async () => {
    server = await startAuthFixtureServer();
    const e = suiteEnvironment(server.origin);
    saveSuite(e.store, "demo", { id: "smoke", name: "Smoke", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }], limits: {} });
    const dirs = ["--profiles-dir", e.profilesDir, "--runs-dir", e.runsDir];
    const withPassword = await cli(["--profile", "demo", "--suite", "smoke", "--password", "x", ...dirs]);
    expect(withPassword).toMatchObject({ code: EXIT.REJECTED, err: expect.stringContaining("never accepted as command-line arguments") });
    expect((await cli(["--profile", "demo", "--suite", "nope", ...dirs])).code).toBe(EXIT.REJECTED);
    const noCreds = await cli(["--profile", "demo", "--suite", "smoke", ...dirs], {});
    expect(noCreds).toMatchObject({ code: EXIT.REJECTED, err: expect.stringContaining("Unattended authentication is not configured") });
    expect(totalHits()).toBe(0);
  });

  it("exit codes 0 / 1 / 2 match PASS / FAIL / INCOMPLETE, and --json matches the run's suite-result.json", async () => {
    server = await startAuthFixtureServer();
    const e = suiteEnvironment(server.origin);
    saveSuite(e.store, "demo", { id: "smoke", name: "Smoke", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }, { kind: "api-check", id: "ME", required: true }], limits: {} });
    const dirs = ["--profiles-dir", e.profilesDir, "--runs-dir", e.runsDir];
    const jsonPath = join(mkdtempSync(join(tmpdir(), "autoqa-cli-")), "result.json");

    const pass = await cli(["--profile", "demo", "--suite", "smoke", "--json", jsonPath, ...dirs]);
    expect(pass.code).toBe(EXIT.PASS);
    const json = JSON.parse(readFileSync(jsonPath, "utf-8")) as CliJson;
    const onDisk = readSuiteResult(join(e.runsDir, json.runId))!;
    expect(json).toMatchObject({ decision: onDisk.decision, counts: onDisk.counts, coverageGaps: onDisk.coverageGaps, suite: { id: "smoke", revision: 1 } });
    expect(pass.out).toContain("Decision: PASS");
    const suite = findSuite(e.profilesDir, "demo", "smoke");
    approveBaseline(e.profilesDir, e.runsDir, "demo", suite, suiteContentHash(suite), json.runId);

    server.setBugs({ apiMeMissingEmail: true });
    const fail = await cli(["--profile", "demo", "--suite", "smoke", "--json", jsonPath, ...dirs]);
    expect(fail.code).toBe(EXIT.FAIL);
    expect(fail.out).toContain("Newly failing: api-check:ME#field:email");
    expect((JSON.parse(readFileSync(jsonPath, "utf-8")) as CliJson).comparison.newlyFailing.map((f) => f.identity)).toEqual(["api-check:ME#field:email"]);

    server.setBugs({});
    const stopped = await cli(["--profile", "demo", "--suite", "smoke", ...dirs], env, true);
    expect(stopped.code).toBe(EXIT.INCOMPLETE);
    expect(stopped.out).toContain("Decision: INCOMPLETE");

    for (const run of [pass, fail, stopped]) expect(run.out + run.err).not.toContain(credentials.password);
    expect(readFileSync(jsonPath, "utf-8")).not.toContain(credentials.password);
  }, 240_000);
});
