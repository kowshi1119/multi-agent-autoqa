import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BudgetSnapshot } from "./budget.js";
import { redactSecrets } from "./redact.js";
import type { Finding, FindingCategory } from "./types.js";

export type RunSummary = {
  runId: string;
  project: string;
  target: string;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "failed" | "cancelled";
  stopReason?: string;
  provider: string;
  actionsPerformed: number;
  modelCalls: number;
  suspectedFindings: number;
  validatedFindings: number;
  rejectedFindings: number;
  needsHuman: number;
  /** Every finding's reportDisposition (independent of FindingStatus -- see the type's doc comment). */
  reportDispositionBreakdown: {
    report: number;
    suppress: number;
    needs_human: number;
  };
  coverage: {
    pagesDiscovered: number;
    pagesVisited: number;
    interactiveControlsDiscovered: number;
    heuristicsApplicable: number;
    heuristicsExecuted: number;
    /** executed/applicable — "heuristic coverage", not application test coverage. */
    heuristicCoverage: number;
  };
  budget: BudgetSnapshot;
  /**
   * Provider usage accounting (Phase 4 Milestone D1). `requests` is
   * always a real measured count (BudgetTracker's own
   * modelCalls/criticCalls counters, corroborated by UsageTracker);
   * `tokenUsage` is null whenever the provider didn't report it (the
   * common case for most paths today) -- never fabricated as 0.
   * `estimatedCostUsd` is null unless verified pricing metadata exists
   * for the resolved model (see src/models/pricing.ts) -- a null value
   * means monetary cost cannot be guaranteed, not that it was zero.
   */
  usage: {
    explorer: { requests: number; tokenUsage: { input: number; output: number } | null };
    critic: { requests: number; tokenUsage: { input: number; output: number } | null };
    estimatedCostUsd: number | null;
    costDisclosure: string;
  };
};

/**
 * 2026-09-14 addendum fix, defense-in-depth: this used to strip the
 * milliseconds fraction entirely, so two calls landing within the same
 * second produced an IDENTICAL runId -- and since RunManager's runDir is
 * derived straight from this value, two such runs would silently write
 * into the same directory (ensureDir()'s mkdirSync({recursive:true})
 * doesn't throw on an existing one). RunManager's own `starting` flag
 * (see run-manager.ts#startRun) already closes the concurrent-call race
 * within a single instance; keeping millisecond resolution here is
 * additional hardening beyond that specific case (e.g. rapid sequential
 * calls, or multiple RunManager instances/processes).
 *
 * 2026-09-15 fix: millisecond resolution alone is still exactly
 * collision-prone for any DIRECT caller without RunManager's own
 * synchronous `starting`-flag guard (src/index.ts, src/benchmark.ts,
 * src/phase3-experiment.ts all call this directly) -- two calls in the
 * same millisecond (a real possibility on a fast machine, or from two
 * separate processes) still produced an identical id. A short random
 * suffix makes THIS function collision-resistant on its own, not just as
 * an emergent property of one specific caller's separate guard. Nothing
 * downstream parses the id's internal structure via regex (confirmed:
 * every consumer either displays it verbatim or strips the "RUN-" prefix
 * as a plain string op), so appending a suffix is safe.
 */
export function generateRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "").replace("T", "-");
  const suffix = randomBytes(2).toString("hex");
  return `RUN-${stamp}-${suffix}`;
}

export function generateFindingId(index: number): string {
  return `FINDING-${String(index).padStart(3, "0")}`;
}

const FINDING_TITLES: Record<string, string> = {
  "console-error": "New browser console error appears after form submission",
  "page-error": "New uncaught runtime error appears after interaction",
  "http-failure": "Server returns an HTTP 5xx response after interaction",
  "duplicate-request": "Interaction produces more requests than expected",
};

/**
 * Deterministic from the oracle id alone — never requires an extra model
 * call just to produce a human-readable finding title.
 */
export function buildFindingTitle(oracleId: string): string {
  return FINDING_TITLES[oracleId] ?? `Anomaly detected by oracle "${oracleId}"`;
}

const FINDING_CATEGORIES: Record<string, FindingCategory> = {
  "console-error": "console",
  "page-error": "runtime",
  "http-failure": "network",
  "duplicate-request": "network",
};

/** Deterministic from the oracle id alone, same reasoning as buildFindingTitle. */
export function categoryForOracle(oracleId: string): FindingCategory {
  return FINDING_CATEGORIES[oracleId] ?? "functional";
}

const FINDING_NARRATIVES: Record<string, { expected: string; actual: string }> = {
  "console-error": {
    expected: "Submitting the form should not introduce an unexpected browser console error.",
    actual: "A new error-level console message appeared after form submission.",
  },
  "page-error": {
    expected: "The interaction should complete without introducing an uncaught browser runtime error.",
    actual: "The interaction produced a new uncaught browser error.",
  },
  "http-failure": {
    expected: "The interaction should not cause the server to return an HTTP 5xx response.",
    actual: "The interaction caused the server to return a new HTTP 5xx response.",
  },
  "duplicate-request": {
    expected: "A single interaction should not produce more requests than expected.",
    actual: "A single interaction produced more matching requests than expected.",
  },
};

/** Human-readable narrative for the finding; the oracle's own expected/actual stays technical. */
export function buildFindingNarrative(
  oracleId: string,
  fallback: { expected: string; actual: string }
): { expected: string; actual: string } {
  return FINDING_NARRATIVES[oracleId] ?? fallback;
}

/**
 * 2026-09-15 fix: this had ZERO redaction, unlike src/evidence.ts#writeJson()'s
 * already-correct pattern -- finding.json could carry a raw credential
 * embedded in Finding.url (or anywhere else in the object) straight to
 * disk. Mirrors evidence.ts's exact idiom.
 */
export function writeFindingJson(evidenceDir: string, finding: Finding, extraSecrets: readonly string[] = []): void {
  writeFileSync(join(evidenceDir, "finding.json"), redactSecrets(JSON.stringify(finding, null, 2), extraSecrets), "utf-8");
}

export function writeRunSummary(runDir: string, summary: RunSummary): void {
  writeFileSync(join(runDir, "run-summary.json"), JSON.stringify(summary, null, 2), "utf-8");
}
