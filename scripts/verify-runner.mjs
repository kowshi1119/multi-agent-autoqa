import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, fstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Runs verification stages one after another with durable, per-stage logs
 * and a machine-readable summary (verification/<ID>/summary.json).
 *
 * - Output goes straight from the child to a log file descriptor: nothing
 *   is buffered in this process's memory.
 * - Commands are spawned with an argument array and no shell, so paths
 *   with spaces are passed safely.
 * - The first stage that does not pass stops the run; later stages are
 *   recorded as "not-run", never as passed.
 * - On timeout or SIGINT/SIGTERM only the current child's own process tree
 *   is terminated (no unrelated browser or Node processes).
 * - Environment variable values are never written anywhere.
 */

export function newVerificationId(now = new Date()) {
  return `VER-${now.toISOString().replace(/[-:.]/g, "").replace("T", "-")}-${randomBytes(2).toString("hex")}`;
}

/** Kills one child and its descendants; never touches other processes. */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}

/**
 * File names from `git status --porcelain` output (no contents). Each line is
 * "XY <path>" where X or Y may be a space, so lines must not be trimmed
 * before the two status columns are removed; renames keep the new name.
 */
export function changedFilesFromPorcelain(text) {
  return text.split(/\r?\n/).filter((line) => line.length > 3).map((line) => {
    const path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    return arrow >= 0 ? path.slice(arrow + 4) : path;
  });
}

/** The Chromium build Playwright installs, from playwright-core's browsers.json (not an exported module path). */
export function playwrightBrowser(resolvePackageJson) {
  try {
    const browsers = JSON.parse(readFileSync(join(dirname(resolvePackageJson("playwright-core/package.json")), "browsers.json"), "utf8")).browsers;
    const chromium = browsers.find((b) => b.name === "chromium");
    return chromium ? `chromium ${chromium.browserVersion} (revision ${chromium.revision})` : null;
  } catch {
    return null; // informational only; recorded as unknown
  }
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** Reads at most the last 64 KiB of a log to find the test runner's summary lines. */
export function testCountsFrom(logPath) {
  let fd;
  try {
    fd = openSync(logPath, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 65_536);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8").replace(ANSI, "");
    const files = /Test Files\s+([^\n]*?)\s*\((\d+)\)/.exec(text);
    const tests = /\n\s*Tests\s+([^\n]*?)\s*\((\d+)\)/.exec(text);
    if (!tests) return undefined;
    const pick = (line, word) => Number((new RegExp(`(\\d+) ${word}`).exec(line) ?? [])[1] ?? 0);
    return {
      files: files ? { total: Number(files[2]), passed: pick(files[1], "passed"), failed: pick(files[1], "failed") } : undefined,
      tests: { total: Number(tests[2]), passed: pick(tests[1], "passed"), failed: pick(tests[1], "failed"), skipped: pick(tests[1], "skipped") },
    };
  } catch {
    return undefined; // counts are informational; the stage state comes from the exit status
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function runStage(stage, { cwd, env, logPath, register }) {
  return new Promise((resolve) => {
    const fd = openSync(logPath, "w");
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSync(fd);
      register(undefined);
      resolve(result);
    };
    let child;
    try {
      child = spawn(stage.command, stage.args, { cwd, env, stdio: ["ignore", fd, fd], windowsHide: true, detached: process.platform !== "win32" });
    } catch (error) {
      finish({ state: "failed", exitCode: null, signal: null, launchError: error instanceof Error ? error.message : String(error) });
      return;
    }
    register(child);
    child.on("error", (error) => finish({ state: "failed", exitCode: null, signal: null, launchError: error.message }));
    child.on("exit", (code, signal) => {
      if (child.interruptedBy) finish({ state: "interrupted", exitCode: code, signal, interruptedBy: child.interruptedBy });
      else finish({ state: code === 0 ? "passed" : "failed", exitCode: code, signal });
    });
    if (stage.timeoutMs) timer = setTimeout(() => { child.interruptedBy = "timeout"; killTree(child); }, stage.timeoutMs);
  });
}

/**
 * Runs `stages` in order and returns the summary. `meta` is copied into the
 * summary as given (callers pass only non-secret facts).
 */
export async function runStages({ stages, outDir, cwd = process.cwd(), env = process.env, meta = {}, handleSignals = false }) {
  mkdirSync(outDir, { recursive: true });
  const summary = {
    schemaVersion: 1,
    ...meta,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    state: "running",
    stages: stages.map((s) => ({ name: s.name, command: s.display ?? [s.command, ...s.args].join(" "), state: "not-run" })),
  };
  const write = () => writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  let current;
  let signalled;
  const onSignal = (signal) => { signalled = signal; if (current) { current.interruptedBy = signal; killTree(current); } };
  if (handleSignals) { process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal); }
  write();
  try {
    for (const [index, stage] of stages.entries()) {
      const record = summary.stages[index];
      if (signalled) break;
      const logPath = join(outDir, `${String(index + 1).padStart(2, "0")}-${stage.name}.log`);
      const started = Date.now();
      record.startedAt = new Date(started).toISOString();
      record.state = "running";
      record.log = logPath;
      write();
      const result = await runStage(stage, { cwd, env, logPath, register: (child) => { current = child; } });
      Object.assign(record, result, { finishedAt: new Date().toISOString(), durationMs: Date.now() - started });
      const counts = stage.countTests ? testCountsFrom(logPath) : undefined;
      if (counts) record.counts = counts;
      write();
      if (record.state !== "passed") break;
    }
  } finally {
    if (handleSignals) { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
  }
  const failing = summary.stages.find((s) => s.state === "failed" || s.state === "interrupted");
  summary.state = failing ? failing.state : summary.stages.every((s) => s.state === "passed") ? "passed" : "interrupted";
  summary.firstFailingStage = failing?.name ?? null;
  summary.exitCode = summary.state === "passed" ? 0 : failing && typeof failing.exitCode === "number" && failing.exitCode > 0 ? failing.exitCode : 1;
  summary.finishedAt = new Date().toISOString();
  write();
  return summary;
}
