import type { ChildProcess } from "node:child_process";

export type StageState = "not-run" | "running" | "passed" | "failed" | "interrupted";
export type Stage = { name: string; command: string; args: string[]; display?: string; timeoutMs?: number; countTests?: boolean };
export type StageRecord = {
  name: string;
  command: string;
  state: StageState;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  launchError?: string;
  interruptedBy?: string;
  log?: string;
  counts?: { files?: { total: number; passed: number; failed: number }; tests: { total: number; passed: number; failed: number; skipped: number } };
};
export type VerificationSummary = {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string | null;
  state: "running" | "passed" | "failed" | "interrupted";
  firstFailingStage?: string | null;
  exitCode?: number;
  stages: StageRecord[];
  [key: string]: unknown;
};
export function newVerificationId(now?: Date): string;
export function killTree(child: ChildProcess | undefined): void;
export function changedFilesFromPorcelain(text: string): string[];
export function playwrightBrowser(resolvePackageJson: (id: string) => string): string | null;
export function testCountsFrom(logPath: string): StageRecord["counts"] | undefined;
export function runStages(options: { stages: Stage[]; outDir: string; cwd?: string; env?: NodeJS.ProcessEnv; meta?: Record<string, unknown>; handleSignals?: boolean }): Promise<VerificationSummary>;
