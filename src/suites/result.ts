import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChecksLedger, CheckLedgerEntry } from "../checks/types.js";
import { redactSecrets } from "../redact.js";
import type { RunSummary } from "../report.js";
import type { Suite, SuiteItem, SuiteLimits, SuiteTarget } from "./suite-manifest.js";

/**
 * A suite run's deterministic outcome, derived only from the run's own
 * artifacts (workflow records, check ledger, authentication result). No
 * model output is consulted. The decision applies to the selected suite
 * only and is never presented as proof the application is defect-free.
 */
export type ItemStatus = "passed" | "failed" | "not-executed" | "unsupported";
export type SuiteAssertion = { id: string; identity: string; assertion: string; expected: string; observed: string; passed: boolean };
export type SuiteItemResult = {
  identity: string;
  kind: SuiteItem["kind"];
  itemId: string;
  required: boolean;
  definitionHash: string;
  status: ItemStatus;
  reason: string;
  assertions: SuiteAssertion[];
  /** Observed attempts for a failing result; a single retry is reported as counts, never labelled "flaky". */
  attempts?: { total: number; failed: number };
  reproduced?: boolean | null;
  evidenceRefs: string[];
  findingFingerprint?: string;
  limitation?: string;
};
export type SuiteDecision = "PASS" | "FAIL" | "INCOMPLETE";
export type SuiteRunSnapshot = {
  schemaVersion: 1;
  runId: string;
  profileId: string;
  suite: { id: string; name: string; revision: number; contentHash: string; items: SuiteItem[] };
  target: SuiteTarget;
  executionSettings: { limits: SuiteLimits; effectiveLimits: { maxActions: number; maxDurationMs: number; maxApiRequests: number }; mode: string };
  recordedAt: string;
};
export type SuiteResult = {
  schemaVersion: 1;
  runId: string;
  profileId: string;
  suite: SuiteRunSnapshot["suite"] & { name: string };
  target: SuiteTarget;
  executionSettings: SuiteRunSnapshot["executionSettings"];
  runStatus: RunSummary["status"] | "unknown";
  stopReason?: string;
  authentication: "not-required" | "verified" | "failed" | "not-attempted";
  decision: SuiteDecision;
  decisionReason: string;
  /** Required items without a pass/fail result. Present alongside FAIL too, so both facts are visible. */
  coverageGaps: Array<{ identity: string; status: ItemStatus; reason: string }>;
  scope: string;
  items: SuiteItemResult[];
  counts: { required: number; optional: number; passed: number; failed: number; notExecuted: number; unsupported: number };
  accounting: { browserActions: number; httpCheckRequests: number; modelDecisions: number; externalModelRequests: number | "unknown" };
};

const readJson = <T>(path: string): T | undefined => {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) as T : undefined; } catch { return undefined; }
};
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "assertion";

/** Why a check that did not run is "not executed" (coverage gap) rather than "unsupported" (capability limit). */
export function classifyNotRun(reason: string): "not-executed" | "unsupported" {
  return /cancel|budget|duration limit|expired|no authenticated session|authentication did not succeed|finding budget/i.test(reason) ? "not-executed" : "unsupported";
}

type WorkflowRecord = { workflowId: string; status: string; reason: string; evidence?: Record<string, unknown> };
type RecordedAssertion = { id?: string; assertion: string; expected: string; observed: string; passed: boolean };

function workflowItem(item: SuiteItem, record: WorkflowRecord | undefined, runCause: string | undefined): Omit<SuiteItemResult, "identity" | "kind" | "itemId" | "required" | "definitionHash"> {
  if (!record) return { status: "not-executed", reason: runCause ?? "No result was recorded for this workflow.", assertions: [], evidenceRefs: [] };
  const evidence = record.evidence ?? {};
  const failureKind = evidence["failureKind"] as string | null | undefined;
  const current = (evidence["assertion"] as { assertions?: RecordedAssertion[] } | undefined)?.assertions ?? [];
  const first = (evidence["firstAttempt"] as { passed?: boolean; assertions?: RecordedAssertion[] } | undefined);
  const assertions = current.map((a) => {
    const id = a.id ?? slug(a.assertion);
    return { id, identity: `workflow:${item.id}#${id}`, assertion: a.assertion, expected: a.expected, observed: a.observed, passed: a.passed };
  });
  const evidenceRefs = [`workflows/${item.id}.json`];
  if (record.status === "completed") return { status: "passed", reason: record.reason, assertions, evidenceRefs };
  if (record.status === "failed" && failureKind === "application-assertion") {
    const lastFailed = current.some((a) => !a.passed) ? 1 : 0;
    const firstFailed = first ? (first.passed === false || (first.assertions ?? []).some((a) => !a.passed) ? 1 : 0) : 0;
    const total = (evidence["attempts"] as number | undefined) ?? (first ? 2 : 1);
    // An intermittent result (failed, then passed on the retry) still keeps
    // the failing attempt: the first attempt's assertions are what failed.
    const failingAssertions = lastFailed || !first?.assertions ? assertions : first.assertions.map((a) => {
      const id = a.id ?? slug(a.assertion);
      return { id, identity: `workflow:${item.id}#${id}`, assertion: a.assertion, expected: a.expected, observed: a.observed, passed: a.passed };
    });
    return {
      status: "failed",
      reason: record.reason,
      assertions: failingAssertions,
      attempts: { total, failed: firstFailed + lastFailed },
      reproduced: (evidence["reproduced"] as boolean | null | undefined) ?? null,
      evidenceRefs,
    };
  }
  if (record.status === "unsupported" || failureKind === "unsupported") return { status: "unsupported", reason: record.reason, assertions: [], evidenceRefs };
  const cause = failureKind === "autoqa-control" ? `Not executed: declared control not found or not actionable (AutoQA/configuration issue, or the application changed the control) — ${record.reason}`
    : `Not executed (${failureKind ?? record.status}): ${record.reason}`;
  return { status: "not-executed", reason: runCause && /auth/i.test(runCause) ? runCause : cause, assertions: [], evidenceRefs };
}

function checkItem(item: SuiteItem, entry: CheckLedgerEntry | undefined, runCause: string | undefined): Omit<SuiteItemResult, "identity" | "kind" | "itemId" | "required" | "definitionHash"> {
  if (!entry) return { status: "not-executed", reason: runCause ?? "No result was recorded for this check.", assertions: [], evidenceRefs: [] };
  const identity = (id: string) => `${item.kind}:${item.id}#${id}`;
  const executed = entry.ran && entry.classification !== "unsupported";
  const limitation = item.kind === "security-check" ? "A failed security check means the declared expectation was not met; it does not by itself establish an exploitable vulnerability." : undefined;
  if (!executed) {
    const reason = entry.blockedReason ?? entry.observation;
    return { status: classifyNotRun(reason), reason, assertions: [], evidenceRefs: entry.evidenceRefs };
  }
  const failed = entry.classification === "confirmed" || entry.classification === "needs_review";
  const assertions: SuiteAssertion[] = item.kind === "api-check" && entry.assertionResults?.length
    ? entry.assertionResults.map((a) => ({ ...a, identity: identity(a.id) }))
    : [{ id: "result", identity: identity("result"), assertion: entry.assertion, expected: entry.assertion, observed: entry.observation, passed: !failed }];
  return {
    status: failed ? "failed" : "passed",
    reason: entry.observation,
    assertions,
    ...(failed ? { attempts: entry.attempts ?? { total: 1, failed: 1 }, reproduced: entry.classification === "confirmed" } : {}),
    evidenceRefs: entry.evidenceRefs,
    ...(entry.findingFingerprint ? { findingFingerprint: entry.findingFingerprint } : {}),
    ...(limitation ? { limitation } : {}),
  };
}

export function decideSuite(items: SuiteItemResult[]): Pick<SuiteResult, "decision" | "decisionReason" | "coverageGaps"> {
  const required = items.filter((i) => i.required);
  const failed = required.filter((i) => i.status === "failed");
  const coverageGaps = required.filter((i) => i.status !== "passed" && i.status !== "failed").map((i) => ({ identity: i.identity, status: i.status, reason: i.reason }));
  if (failed.length) return { decision: "FAIL", coverageGaps, decisionReason: `${failed.length} required item(s) produced a failing result${coverageGaps.length ? `; in addition ${coverageGaps.length} required item(s) were not executed, so coverage is also incomplete` : ""}.` };
  if (coverageGaps.length) return { decision: "INCOMPLETE", coverageGaps, decisionReason: `${coverageGaps.length} required item(s) have no pass/fail result (not executed or unsupported); a missing result is not a pass.` };
  if (!required.length) return { decision: "INCOMPLETE", coverageGaps, decisionReason: "The suite has no required items." };
  return { decision: "PASS", coverageGaps, decisionReason: `All ${required.length} required item(s) executed and passed.` };
}

export function buildSuiteResult(runDir: string, snapshot: SuiteRunSnapshot, authRequired: boolean): SuiteResult {
  const run = readJson<RunSummary>(join(runDir, "run-summary.json"));
  const auth = readJson<{ status: string; reason?: string }>(join(runDir, "authentication.json"));
  const ledger = readJson<ChecksLedger>(join(runDir, "check-results.json"));
  const usage = readJson<{ requests: number }>(join(runDir, "check-usage.json"));
  const records = new Map<string, WorkflowRecord>();
  const dir = join(runDir, "workflows");
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => /^[A-Za-z0-9_-]+\.json$/.test(f))) {
      const record = readJson<WorkflowRecord>(join(dir, file));
      if (record?.workflowId) records.set(record.workflowId, record);
    }
  }
  const authentication: SuiteResult["authentication"] = !authRequired ? "not-required" : !auth ? "not-attempted" : auth.status === "success" ? "verified" : "failed";
  const runCause = authentication === "failed" ? "Not executed: authentication did not succeed for this run (not an application regression)."
    : authentication === "not-attempted" ? "Not executed: the run ended before authentication."
    : run?.status === "cancelled" ? "Not executed: the run was cancelled."
    : run?.status === "failed" ? `Not executed: the run failed (${run.stopReason ?? "unknown"}).`
    : undefined;
  const items: SuiteItemResult[] = snapshot.suite.items.map((item) => {
    const base = { identity: `${item.kind}:${item.id}`, kind: item.kind, itemId: item.id, required: item.required, definitionHash: item.definitionHash };
    const detail = item.kind === "workflow"
      ? workflowItem(item, authentication === "failed" ? undefined : records.get(item.id), runCause)
      : checkItem(item, authentication === "failed" ? undefined : ledger?.entries.find((e) => e.checkId === item.id), runCause);
    return { ...base, ...detail };
  });
  const decision = decideSuite(items);
  const count = (status: ItemStatus) => items.filter((i) => i.status === status).length;
  return {
    schemaVersion: 1,
    runId: snapshot.runId,
    profileId: snapshot.profileId,
    suite: snapshot.suite,
    target: snapshot.target,
    executionSettings: snapshot.executionSettings,
    runStatus: run?.status ?? "unknown",
    ...(run?.stopReason ? { stopReason: run.stopReason } : {}),
    authentication,
    ...decision,
    scope: `Applies only to suite "${snapshot.suite.name}" revision ${snapshot.suite.revision} on ${snapshot.target.origin} (${snapshot.target.environmentKind}). It is not evidence that the whole application is secure or defect-free.`,
    items,
    counts: { required: items.filter((i) => i.required).length, optional: items.filter((i) => !i.required).length, passed: count("passed"), failed: count("failed"), notExecuted: count("not-executed"), unsupported: count("unsupported") },
    accounting: {
      browserActions: run?.actionsPerformed ?? 0,
      httpCheckRequests: usage?.requests ?? 0,
      modelDecisions: run?.modelCalls ?? 0,
      externalModelRequests: run?.usage ? run.usage.explorer.requests + run.usage.critic.requests : "unknown",
    },
  };
}

export function readSuiteRunSnapshot(runDir: string): SuiteRunSnapshot | undefined {
  return readJson<SuiteRunSnapshot>(join(runDir, "suite-run.json"));
}

export function readSuiteResult(runDir: string): SuiteResult | undefined {
  return readJson<SuiteResult>(join(runDir, "suite-result.json"));
}

export function writeJsonRedacted(path: string, value: unknown, secrets: readonly string[]): void {
  writeFileSync(path, redactSecrets(JSON.stringify(value, null, 2), secrets), "utf-8");
}

export function snapshotFor(runId: string, profileId: string, suite: Suite, contentHash: string, effectiveLimits: SuiteRunSnapshot["executionSettings"]["effectiveLimits"], mode: string): SuiteRunSnapshot {
  return {
    schemaVersion: 1, runId, profileId,
    suite: { id: suite.id, name: suite.name, revision: suite.revision, contentHash, items: suite.items },
    target: suite.target,
    executionSettings: { limits: suite.limits, effectiveLimits, mode },
    recordedAt: new Date().toISOString(),
  };
}
