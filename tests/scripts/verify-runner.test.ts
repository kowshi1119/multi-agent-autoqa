import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { changedFilesFromPorcelain, newVerificationId, playwrightBrowser, runStages, testCountsFrom, type Stage } from "../../scripts/verify-runner.mjs";

/** Controlled subprocesses only: the real stages are never run from here. */
const node = (name: string, script: string, extra: Partial<Stage> = {}): Stage => ({ name, command: process.execPath, args: ["-e", script], ...extra });
const workdir = () => mkdtempSync(join(tmpdir(), "autoqa verify runner "));

describe("verification runner", () => {
  it("records passing stages with durable logs and a summary", async () => {
    const dir = workdir();
    const summary = await runStages({ stages: [node("first", "console.log('hello from first')"), node("second", "console.log('second ok')")], outDir: join(dir, "out"), cwd: dir });
    expect(summary).toMatchObject({ state: "passed", exitCode: 0, firstFailingStage: null });
    expect(summary.stages.map((s) => [s.name, s.state, s.exitCode])).toEqual([["first", "passed", 0], ["second", "passed", 0]]);
    expect(readFileSync(summary.stages[0]!.log!, "utf8")).toContain("hello from first");
    expect(JSON.parse(readFileSync(join(dir, "out", "summary.json"), "utf8")).state).toBe("passed");
  });

  it("stops at the first failure, propagates its exit code and never reports later stages as passed", async () => {
    const dir = workdir();
    const summary = await runStages({ stages: [node("ok", "0"), node("broken", "console.error('boom'); process.exit(7)"), node("later", "0")], outDir: join(dir, "out"), cwd: dir });
    expect(summary).toMatchObject({ state: "failed", exitCode: 7, firstFailingStage: "broken" });
    expect(summary.stages.map((s) => s.state)).toEqual(["passed", "failed", "not-run"]);
    expect(readFileSync(summary.stages[1]!.log!, "utf8")).toContain("boom");
    expect(summary.stages[2]!.log).toBeUndefined();
  });

  it("records a process that cannot start as a launch failure", async () => {
    const dir = workdir();
    const summary = await runStages({ stages: [{ name: "missing", command: join(dir, "no-such-executable"), args: [] }, node("later", "0")], outDir: join(dir, "out"), cwd: dir });
    expect(summary).toMatchObject({ state: "failed", exitCode: 1, firstFailingStage: "missing" });
    expect(summary.stages[0]!.launchError).toMatch(/ENOENT/);
    expect(summary.stages[1]!.state).toBe("not-run");
  });

  it("interrupts a stage that exceeds its timeout, killing only that child", async () => {
    const dir = workdir();
    const started = Date.now();
    const summary = await runStages({ stages: [node("hangs", "setInterval(() => {}, 1000)", { timeoutMs: 500 }), node("later", "0")], outDir: join(dir, "out"), cwd: dir });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(summary).toMatchObject({ state: "interrupted", exitCode: 1, firstFailingStage: "hangs" });
    expect(summary.stages[0]).toMatchObject({ state: "interrupted", interruptedBy: "timeout" });
    expect(summary.stages[1]!.state).toBe("not-run");
  });

  it("works in a directory whose path contains spaces and keeps earlier failed records", async () => {
    const dir = workdir();
    const root = join(dir, "verification records");
    mkdirSync(root);
    const failed = await runStages({ stages: [node("cwd", "process.exit(process.cwd().includes(' ') ? 3 : 0)")], outDir: join(root, newVerificationId()), cwd: dir });
    expect(failed.exitCode).toBe(3);
    const passed = await runStages({ stages: [node("ok", "0")], outDir: join(root, newVerificationId(new Date(Date.now() + 1000))), cwd: dir });
    expect(passed.state).toBe("passed");
    const records = readdirSync(root).map((d) => JSON.parse(readFileSync(join(root, d, "summary.json"), "utf8")).state).sort();
    expect(records).toEqual(["failed", "passed"]);
  });

  it("reads changed file names from porcelain output without losing a leading status space", () => {
    // Regression: trimming the whole output turned " M .gitignore" into "gitignore".
    expect(changedFilesFromPorcelain(" M .gitignore\nD  \"src/a b.lnk\"\n?? scripts/x.mjs\nR  old.ts -> new.ts\n")).toEqual([".gitignore", "\"src/a b.lnk\"", "scripts/x.mjs", "new.ts"]);
  });

  it("finds the installed Playwright browser build (browsers.json is not an exported path)", () => {
    const require = createRequire(import.meta.url);
    expect(playwrightBrowser((id) => require.resolve(id))).toMatch(/^chromium \d+\.\d+\.\d+\.\d+ \(revision \d+\)$/);
    expect(playwrightBrowser(() => { throw new Error("not installed"); })).toBeNull();
  });

  it("reads test counts from a test runner's summary lines", async () => {
    const dir = workdir();
    const summary = await runStages({ stages: [node("tests", "console.log('\\u001b[2m Test Files \\u001b[22m 1 failed | 102 passed (103)'); console.log('      Tests  2 failed | 785 passed | 1 skipped (788)'); process.exit(1)", { countTests: true })], outDir: join(dir, "out"), cwd: dir });
    expect(summary.stages[0]!.counts).toEqual({ files: { total: 103, passed: 102, failed: 1 }, tests: { total: 788, passed: 785, failed: 2, skipped: 1 } });
    expect(testCountsFrom(join(dir, "nope.log"))).toBeUndefined();
    expect(existsSync(join(dir, "out", "summary.json"))).toBe(true);
  });
});
