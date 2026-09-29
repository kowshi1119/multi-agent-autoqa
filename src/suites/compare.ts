import type { Baseline } from "./baselines.js";
import type { SuiteAssertion, SuiteItemResult, SuiteResult } from "./result.js";

/**
 * Assertion-level comparison of a suite run against its approved baseline.
 * Matching is by stable identity (`<kind>:<itemId>#<assertionId>`), never by
 * display order. It is separate from the suite decision: a run's PASS/FAIL
 * stands on its own declared assertions, and a comparison that would
 * mislead is refused with a reason instead of producing a verdict.
 */
export type ComparisonCategory =
  | "newly-failing" | "still-failing" | "fixed" | "unchanged-passing"
  | "added" | "removed" | "not-executed" | "unsupported" | "incomparable";

export type ComparisonEntry = {
  identity: string;
  itemIdentity: string;
  required: boolean;
  category: ComparisonCategory;
  assertion: string;
  expected?: string;
  observed?: string;
  baselineObserved?: string;
  reason?: string;
  evidenceRefs: string[];
  baselineEvidenceRefs: string[];
  reproduction?: string;
  sameFindingAsBaseline?: boolean;
};

export type SuiteComparison = {
  schemaVersion: 1;
  runId: string;
  baseline: { runId: string; suiteRevision: number; approvedAt: string } | null;
  comparable: boolean;
  reason?: string;
  notes: string[];
  entries: ComparisonEntry[];
  counts: Record<ComparisonCategory, number>;
};

const ORDER: ComparisonCategory[] = ["newly-failing", "still-failing", "not-executed", "unsupported", "incomparable", "fixed", "added", "removed", "unchanged-passing"];
const emptyCounts = (): Record<ComparisonCategory, number> => Object.fromEntries(ORDER.map((c) => [c, 0])) as Record<ComparisonCategory, number>;

function reproduction(item: SuiteItemResult): string | undefined {
  if (item.status !== "failed" || !item.attempts) return undefined;
  const { total, failed } = item.attempts;
  return `failed ${failed} of ${total} attempt(s) in this run (sample size ${total})${item.reproduced === true ? "; mismatch reproduced" : item.reproduced === false ? "; did not reproduce on the retry" : ""}. Not labelled flaky from a single retry.`;
}

/** Whole-run reasons results cannot be compared at all. */
function incompatibility(current: SuiteResult, baseline: Baseline): string | undefined {
  if (baseline.profileId !== current.profileId) return "The baseline belongs to a different application.";
  if (baseline.suiteId !== current.suite.id) return "The baseline belongs to a different suite.";
  if (baseline.target.origin !== current.target.origin) return `The target changed (${baseline.target.origin} → ${current.target.origin}); results are not comparable.`;
  if (baseline.target.environmentKind !== current.target.environmentKind) return `The environment changed (${baseline.target.environmentKind} → ${current.target.environmentKind}); results are not comparable.`;
  if (baseline.target.authMode !== current.target.authMode) return `The authentication mode changed (${baseline.target.authMode} → ${current.target.authMode}); results are not comparable.`;
  if (baseline.target.runSessionAuth !== current.target.runSessionAuth) return `The API session mode changed (${baseline.target.runSessionAuth} → ${current.target.runSessionAuth}); results are not comparable.`;
  return undefined;
}

export function compareToBaseline(current: SuiteResult, baseline: Baseline | undefined): SuiteComparison {
  const base: SuiteComparison = { schemaVersion: 1, runId: current.runId, baseline: null, comparable: false, notes: [], entries: [], counts: emptyCounts() };
  if (!baseline) return { ...base, reason: "No approved baseline for this suite — comparison unavailable. The suite decision above still stands on its own." };
  const withBaseline = { ...base, baseline: { runId: baseline.runId, suiteRevision: baseline.suiteRevision, approvedAt: baseline.approvedAt } };
  if (baseline.runId === current.runId) return { ...withBaseline, reason: "This run is the approved baseline; there is nothing to compare it with." };
  const incompatible = incompatibility(current, baseline);
  if (incompatible) return { ...withBaseline, reason: incompatible };

  const notes: string[] = [];
  if (baseline.suiteRevision !== current.suite.revision) notes.push(`Suite revision changed from ${baseline.suiteRevision} (baseline) to ${current.suite.revision}; unchanged items are compared, changed items are marked incomparable.`);
  const entries: ComparisonEntry[] = [];
  const baseItems = new Map(baseline.items.map((i) => [i.identity, i]));
  const currentItems = new Map(current.items.map((i) => [i.identity, i]));

  for (const item of current.items) {
    const before = baseItems.get(item.identity);
    const common = { itemIdentity: item.identity, required: item.required, evidenceRefs: item.evidenceRefs };
    if (!before) {
      entries.push({ ...common, identity: item.identity, category: "added", assertion: `${item.itemId} added to the suite`, reason: `Current status: ${item.status}.`, baselineEvidenceRefs: [] });
      continue;
    }
    if (before.definitionHash !== item.definitionHash) {
      entries.push({ ...common, identity: item.identity, category: "incomparable", assertion: item.itemId, reason: "The assertion definition changed since the baseline; approve a new baseline to compare this item.", baselineEvidenceRefs: before.evidenceRefs });
      continue;
    }
    if (item.status === "not-executed" || item.status === "unsupported") {
      const assertions: Array<Pick<SuiteAssertion, "identity" | "assertion" | "expected" | "observed">> = before.assertions.length ? before.assertions : [{ identity: item.identity, assertion: item.itemId, expected: "", observed: "" }];
      for (const a of assertions) {
        entries.push({ ...common, identity: a.identity, category: item.status, assertion: a.assertion, ...(a.expected ? { expected: a.expected } : {}), baselineObserved: a.observed, reason: `${item.reason} A missing result is not a pass and not a regression.`, baselineEvidenceRefs: before.evidenceRefs });
      }
      continue;
    }
    const beforeAssertions = new Map(before.assertions.map((a) => [a.identity, a]));
    const nowAssertions = new Map(item.assertions.map((a) => [a.identity, a]));
    for (const a of item.assertions) {
      const prior = beforeAssertions.get(a.identity);
      const detail = { ...common, identity: a.identity, assertion: a.assertion, expected: a.expected, observed: a.observed, baselineEvidenceRefs: before.evidenceRefs };
      if (!prior) { entries.push({ ...detail, category: "added", reason: "New assertion in this item (not in the baseline run)." }); continue; }
      const category: ComparisonCategory = a.passed ? (prior.passed ? "unchanged-passing" : "fixed") : prior.passed ? "newly-failing" : "still-failing";
      const repro = !a.passed ? reproduction(item) : undefined;
      entries.push({
        ...detail,
        category,
        baselineObserved: prior.observed,
        ...(repro ? { reproduction: repro } : {}),
        ...(category === "still-failing" && item.findingFingerprint && before.findingFingerprint ? { sameFindingAsBaseline: item.findingFingerprint === before.findingFingerprint } : {}),
        ...(item.limitation && !a.passed ? { reason: item.limitation } : {}),
      });
    }
    for (const prior of before.assertions) {
      if (!nowAssertions.has(prior.identity)) entries.push({ ...common, identity: prior.identity, category: "removed", assertion: prior.assertion, expected: prior.expected, baselineObserved: prior.observed, reason: "Asserted in the baseline but not reported in this run.", baselineEvidenceRefs: before.evidenceRefs });
    }
  }
  for (const before of baseline.items) {
    if (!currentItems.has(before.identity)) entries.push({ identity: before.identity, itemIdentity: before.identity, required: before.required, category: "removed", assertion: `${before.itemId} removed from the suite`, evidenceRefs: [], baselineEvidenceRefs: before.evidenceRefs });
  }
  entries.sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.identity.localeCompare(b.identity));
  const counts = emptyCounts();
  for (const e of entries) counts[e.category]++;
  if (current.authentication === "failed") notes.push("Authentication failed in this run: items are reported as not executed, not as regressions.");
  return { ...withBaseline, comparable: true, notes, entries, counts };
}
