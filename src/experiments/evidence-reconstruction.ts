import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CriticAttemptScope, CriticEvidenceBundle } from "../critic/critic-runner.js";
import type { ConsoleRecord, EvidenceCompleteness, NetworkRecord, PageErrorRecord } from "../types.js";

function readJsonIfPresent<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/**
 * Rebuilds the CriticEvidenceBundle a live run's Validator originally
 * captured, purely from a finding's already-written evidence files --
 * console.json / network.json / page-errors.json / visible-text.json
 * (screenshot.png / trace.zip are referenced by path, never re-read).
 * Never touches the browser: this is what makes offline replay possible.
 * Shared by the Phase 2 experiment harness (src/phase2-experiment.ts) and
 * the Phase 3 experiment conditions (src/experiments/conditions.ts).
 */
export function readEvidenceBundle(evidenceDir: string): CriticEvidenceBundle {
  const consoleMessages = readJsonIfPresent<ConsoleRecord[]>(join(evidenceDir, "console.json"), []);
  const networkRequests = readJsonIfPresent<NetworkRecord[]>(join(evidenceDir, "network.json"), []);
  const pageErrors = readJsonIfPresent<PageErrorRecord[]>(join(evidenceDir, "page-errors.json"), []);
  const visibleText = readJsonIfPresent<{ excerpt: string }>(join(evidenceDir, "visible-text.json"), { excerpt: "" });
  const hasScreenshot = existsSync(join(evidenceDir, "screenshot.png"));
  const hasTrace = existsSync(join(evidenceDir, "trace.zip"));

  return {
    consoleMessages,
    networkRequests,
    pageErrors,
    visibleTextExcerpt: visibleText.excerpt,
    ...(hasScreenshot ? { screenshotPath: join(evidenceDir, "screenshot.png") } : {}),
    ...(hasTrace ? { tracePath: join(evidenceDir, "trace.zip") } : {}),
  };
}

/** Rebuilds the same CriticAttemptScope the live run computed, from reproduction.json's persisted representativeAttempt/evidenceCompleteness -- so offline review agrees exactly with what the live path would have produced. */
export function readAttemptScope(evidenceDir: string): CriticAttemptScope {
  const reproduction = readJsonIfPresent<{ attempts: number; representativeAttempt?: number; evidenceCompleteness?: EvidenceCompleteness }>(
    join(evidenceDir, "reproduction.json"),
    { attempts: 0 }
  );
  return {
    representativeAttempt: reproduction.representativeAttempt ?? 0,
    totalAttempts: reproduction.attempts,
    completeness: reproduction.evidenceCompleteness ?? "diagnostic-no-success",
  };
}
