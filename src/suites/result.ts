import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChecksLedger, CheckLedgerEntry } from "../checks/types.js";
import { executionFor, itemVerdict, legacyReasonCode, reasonForWorkflowFailureKind, type AssertionVerdict, type ReasonCode } from "../outcomes/outcome.js";
import { redactSecrets } from "../redact.js";
import type { RunSummary } from "../report.js";
import type { Suite, SuiteItem, SuiteLimits, SuiteTarget } from "./suite-manifest.js";

/**
 * A suite run's deterministic outcome, derived only from the run's own
 * artifacts (workflow records, check ledger, authentication result). No
 * model output is consulted, and no free-text wording: every status comes
 * from structured fields (Phase 12 reason codes, assertion verdicts, the
 * workflow `failureKind`), so rewording an explanation never changes a
 * decision. The decision applies to the selected suite only and is never
 * presented as proof the application is defect-free.
 *
 * suite-result schemaVersion 2 adds `reasonCode`, `assertionModel` and
 * per-assertion `verdict`. Version 1 results (Phase 11) remain readable:
 * their `passed` flags map to pass/fail, and anything else is a gap.
 */
export type ItemStatus = "passed" | "failed" | "partially-assessed" | "not-executed" | "unsupported";
export type SuiteAssertion = { id: string; identity: string; assertion: string; expected: string; observed: string; passed: boolean; verdict?: AssertionVerdict; reasonCode?: ReasonCode; confidence?: string; limitations?: string; severityRationale?: string };
export type SuiteItemResult = {
  identity: string;
  kind: SuiteItem["kind"];
  itemId: string;
  required: boolean;
  definitionHash: string;
  status: ItemStatus;
  /** Structured cause (schemaVersion 2). Decisions depend on this and on verdicts, never on `reason` text. */
  reasonCode?: ReasonCode;
  /** Human-readable explanation only. */
  reason: string;
  assertions: SuiteAssertion[];
  /** How the item's assertions are modelled; security checks moved from aggregate (v1) to per-assertion (v2). */
  assertionModel?: "aggregate-v1" | "per-assertion-v2";
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
  schemaVersion: 1 | 2;
  runId: string;
  profileId: string;
  suite: SuiteRunSnapshot["suite"] & { name: string };
  target: SuiteTarget;
  executionSettings: SuiteRunSnapshot["executionSettings"];
  runStatus: RunSummary["status"] | "unknown";
  stopReason?: string;
  /** "interrupted": sign-in was stopped by cancellation or a budget, which is not an authentication failure. */
  authentication: "not-required" | "verified" | "failed" | "interrupted" | "not-attempted";
  decision: SuiteDecision;
  decisionReason: string;
  /** Required items without a pass/fail result. Present alongside FAIL too, so both facts are visible. */
  coverageGaps: Array<{ identity: string; status: ItemStatus; reason: string; reasonCode?: ReasonCode }>;
  scope: string;
  items: SuiteItemResult[];
  counts: { required: number; optional: number; passed: number; failed: number; partiallyAssessed?: number; notExecuted: number; unsupported: number };
  accounting: { browserActions: number; httpCheckRequests: number; modelDecisions: number; externalModelRequests: number | "unknown" };
};

const readJson = <T>(path: string): T | undefined => {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) as T : undefined; } catch { return undefined; }
};
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "assertion";

/** The verdict an assertion supports; older records only have `passed`. */
export function verdictOf(a: { passed: boolean; verdict?: AssertionVerdict }): AssertionVerdict {
  return a.verdict ?? (a.passed ? "pass" : "fail");
}

type RunCause = { code: ReasonCode; explanation: string };
type WorkflowRecord = { workflowId: string; status: string; reason: string; evidence?: Record<string, unknown> };
type RecordedAssertion = { id?: string; assertion: string; expected: string; observed: string; passed: boolean };
type ItemDetail = Omit<SuiteItemResult, "identity" | "kind" | "itemId" | "required" | "definitionHash">;

const notRun = (cause: RunCause, evidenceRefs: string[] = []): ItemDetail => ({
  status: executionFor(cause.code) === "unsupported" ? "unsupported" : "not-executed", reasonCode: cause.code, reason: cause.explanation, assertions: [], evidenceRefs,
});

function workflowItem(item: SuiteItem, record: WorkflowRecord | undefined, runCause: RunCause | undefined): ItemDetail {
  if (!record) return notRun(runCause ?? { code: "not-reached", explanation: "No result was recorded for this workflow." });
  const evidence = record.evidence ?? {};
  const failureKind = evidence["failureKind"] as string | null | undefined;
  const toAssertion = (a: RecordedAssertion): SuiteAssertion => {
    const id = a.id ?? slug(a.assertion);
    return { id, identity: `workflow:${item.id}#${id}`, assertion: a.assertion, expected: a.expected, observed: a.observed, passed: a.passed, verdict: a.passed ? "pass" : "fail" };
  };
  const current = (evidence["assertion"] as { assertions?: RecordedAssertion[] } | undefined)?.assertions ?? [];
  const first = (evidence["firstAttempt"] as { passed?: boolean; assertions?: RecordedAssertion[] } | undefined);
  const assertions = current.map(toAssertion);
  const evidenceRefs = [`workflows/${item.id}.json`];
  if (record.status === "completed") return { status: "passed", reasonCode: "ok", reason: record.reason, assertions, evidenceRefs };
  if (record.status === "failed" && failureKind === "application-assertion") {
    const lastFailed = current.some((a) => !a.passed) ? 1 : 0;
    const firstFailed = first ? (first.passed === false || (first.assertions ?? []).some((a) => !a.passed) ? 1 : 0) : 0;
    const total = (evidence["attempts"] as number | undefined) ?? (first ? 2 : 1);
    // An intermittent result (failed, then passed on the retry) still keeps
    // the failing attempt: the first attempt's assertions are what failed.
    const failingAssertions = lastFailed || !first?.assertions ? assertions : first.assertions.map(toAssertion);
    return { status: "failed", reasonCode: "assertion-failed", reason: record.reason, assertions: failingAssertions, attempts: { total, failed: firstFailed + lastFailed }, reproduced: (evidence["reproduced"] as boolean | null | undefined) ?? null, evidenceRefs };
  }
  // A failed record without a structured kind (older runs) is ambiguous: a gap, not an application failure.
  const code = record.status === "unsupported" ? "missing-configuration" : reasonForWorkflowFailureKind(failureKind);
  return { ...notRun(runCause && (runCause.code === "auth-failed") ? runCause : { code, explanation: record.reason }, evidenceRefs) };
}

function checkItem(item: SuiteItem, entry: CheckLedgerEntry | undefined, runCause: RunCause | undefined): ItemDetail {
  if (!entry) return notRun(runCause ?? { code: "not-reached", explanation: "No result was recorded for this check." });
  const identity = (id: string) => `${item.kind}:${item.id}#${id}`;
  // Version 2 entries carry a code; version 1 entries are read structurally (ran + classification) only.
  const code: ReasonCode = entry.reasonCode ?? legacyReasonCode(entry);
  const assertionModel = item.kind === "security-check" ? (entry.assertionModel ?? "aggregate-v1") : undefined;
  const common = { evidenceRefs: entry.evidenceRefs, ...(assertionModel ? { assertionModel } : {}), ...(entry.findingFingerprint ? { findingFingerprint: entry.findingFingerprint } : {}) };
  if (executionFor(code) !== "executed" && !(entry.ran && entry.assertionResults?.length)) {
    return { ...notRun({ code, explanation: entry.blockedReason ?? entry.observation }, entry.evidenceRefs), ...common };
  }
  const aggregateFailed = entry.classification === "confirmed" || entry.classification === "needs_review";
  const assertions: SuiteAssertion[] = entry.assertionResults?.length
    ? entry.assertionResults.map((a) => ({ ...a, identity: identity(a.id), verdict: verdictOf(a) }))
    : [{ id: "result", identity: identity("result"), assertion: entry.assertion, expected: entry.assertion, observed: entry.observation, passed: !aggregateFailed, verdict: aggregateFailed ? "fail" : "pass" }];
  const verdict = itemVerdict(assertions.map((a) => a.verdict ?? verdictOf(a)));
  const status: ItemStatus = verdict === "not-assessed" ? "not-executed" : verdict;
  const limitation = item.kind === "security-check" ? "A failed security assertion means the declared policy was not met; it does not by itself establish an exploitable vulnerability." : undefined;
  return {
    status,
    reasonCode: status === "passed" ? "ok" : status === "failed" ? "assertion-failed" : code === "ok" ? "not-applicable" : code,
    reason: entry.observation,
    assertions,
    ...(status === "failed" ? { attempts: entry.attempts ?? { total: 1, failed: 1 }, reproduced: entry.classification === "confirmed" || (entry.attempts ? entry.attempts.failed > 1 : null) } : {}),
    ...common,
    ...(limitation ? { limitation } : {}),
  };
}

export function decideSuite(items: SuiteItemResult[]): Pick<SuiteResult, "decision" | "decisionReason" | "coverageGaps"> {
  const required = items.filter((i) => i.required);
  const failed = required.filter((i) => i.status === "failed");
  const coverageGaps = required.filter((i) => i.status !== "passed" && i.status !== "failed").map((i) => ({ identity: i.identity, status: i.status, reason: i.reason, ...(i.reasonCode ? { reasonCode: i.reasonCode } : {}) }));
  if (failed.length) return { decision: "FAIL", coverageGaps, decisionReason: `${failed.length} required item(s) produced a failing result${coverageGaps.length ? `; in addition ${coverageGaps.length} required item(s) were not fully assessed, so coverage is also incomplete` : ""}.` };
  if (coverageGaps.length) return { decision: "INCOMPLETE", coverageGaps, decisionReason: `${coverageGaps.length} required item(s) have no complete pass/fail result (not executed, partially assessed or unsupported); a missing result is not a pass.` };
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
  // authentication.json carries a structured reason (AuthResult) for failures; map it, never its message.
  const authReasonCode: ReasonCode | undefined = !auth || auth.status === "success" || auth.status === "not-required" ? undefined
    : auth.reason === "cancelled" ? "cancelled" : auth.reason === "budget-exhausted" ? "budget-exhausted" : auth.reason === "not-configured" ? "missing-configuration" : "auth-failed";
  const authentication: SuiteResult["authentication"] = !authRequired ? "not-required" : !auth ? "not-attempted" : auth.status === "success" ? "verified"
    : authReasonCode === "cancelled" || authReasonCode === "budget-exhausted" ? "interrupted" : "failed";
  const runCause: RunCause | undefined = authentication === "interrupted" ? { code: authReasonCode!, explanation: `Not executed: sign-in was interrupted (${authReasonCode}).` }
    : authentication === "failed" ? { code: authReasonCode ?? "auth-failed", explanation: "Not executed: authentication did not succeed for this run (not an application regression)." }
    : authentication === "not-attempted" ? { code: run?.status === "cancelled" ? "cancelled" : "not-reached", explanation: "Not executed: the run ended before authentication." }
    : run?.status === "cancelled" ? { code: "cancelled", explanation: "Not executed: the run was cancelled." }
    : run?.status === "failed" ? { code: "internal-error", explanation: `Not executed: the run failed (${run.stopReason ?? "unknown"}).` }
    : undefined;
  const items: SuiteItemResult[] = snapshot.suite.items.map((item) => {
    const base = { identity: `${item.kind}:${item.id}`, kind: item.kind, itemId: item.id, required: item.required, definitionHash: item.definitionHash };
    const detail = item.kind === "workflow"
      ? workflowItem(item, authentication === "failed" || authentication === "interrupted" ? undefined : records.get(item.id), runCause)
      : checkItem(item, authentication === "failed" || authentication === "interrupted" ? undefined : ledger?.entries.find((e) => e.checkId === item.id), runCause);
    return { ...base, ...detail };
  });
  const decision = decideSuite(items);
  const count = (status: ItemStatus) => items.filter((i) => i.status === status).length;
  return {
    schemaVersion: 2,
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
    counts: { required: items.filter((i) => i.required).length, optional: items.filter((i) => !i.required).length, passed: count("passed"), failed: count("failed"), partiallyAssessed: count("partially-assessed"), notExecuted: count("not-executed"), unsupported: count("unsupported") },
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
