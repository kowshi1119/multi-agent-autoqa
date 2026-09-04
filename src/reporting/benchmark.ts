import { readFileSync } from "node:fs";
import type { Finding } from "../types.js";

export type GroundTruthDefect = { id: string; oracleId: string; pathname: string };
export type GroundTruth = { defects: GroundTruthDefect[] };

export type BenchmarkMatch = { groundTruthId: string; findingId: string };

export type BenchmarkResult = {
  matchedOn: "oracleId+pathname";
  seededDefects: number;
  reportedValidatedFindings: number;
  truePositives: BenchmarkMatch[];
  falsePositives: string[];
  falseNegatives: string[];
  precision: number;
  recall: number;
  f1: number;
};

export function loadGroundTruth(path: string): GroundTruth {
  return JSON.parse(readFileSync(path, "utf-8")) as GroundTruth;
}

/**
 * Compares only VALIDATED findings against ground truth. A finding
 * matches a ground-truth entry iff finding.oracle.oracleId === entry.oracleId
 * AND finding.pathname === entry.pathname (finding.pathname is the value
 * stored at creation time, not reparsed from finding.url) -- never by
 * title, narrative, category, heuristic, control label, or substring.
 *
 * "First validated match wins" per entry: a second validated finding that
 * matches an already-claimed ground-truth entry is counted as a false
 * positive. Run-level dedup (§25) is keyed more finely (oracleId+pathname+
 * controlKey+normalizedActual), so two distinct findings CAN legitimately
 * map to the same coarser (oracleId, pathname) ground-truth entry -- this
 * is an expected, documented tension between the two granularities, not a
 * bug: dedup asks "is this the same underlying anomaly report", the
 * benchmark asks "does this correspond to a known seeded defect".
 */
export function matchFindings(validatedFindings: Finding[], groundTruth: GroundTruthDefect[]): BenchmarkResult {
  const matchedGtIds = new Set<string>();
  const truePositives: BenchmarkMatch[] = [];
  const falsePositives: string[] = [];

  for (const finding of validatedFindings) {
    const gt = groundTruth.find(
      (g) => !matchedGtIds.has(g.id) && g.oracleId === finding.oracle.oracleId && g.pathname === finding.pathname
    );
    if (gt) {
      matchedGtIds.add(gt.id);
      truePositives.push({ groundTruthId: gt.id, findingId: finding.id });
    } else {
      falsePositives.push(finding.id);
    }
  }

  const falseNegatives = groundTruth.filter((g) => !matchedGtIds.has(g.id)).map((g) => g.id);

  const precision = validatedFindings.length === 0 ? 0 : truePositives.length / validatedFindings.length;
  const recall = groundTruth.length === 0 ? 0 : truePositives.length / groundTruth.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    matchedOn: "oracleId+pathname",
    seededDefects: groundTruth.length,
    reportedValidatedFindings: validatedFindings.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
  };
}
