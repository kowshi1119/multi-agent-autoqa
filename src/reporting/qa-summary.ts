import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthMechanismSummary } from "../auth/mechanism-observer.js";
import type { ChecksLedger } from "../checks/types.js";
import type { DeclaredWorkflow } from "../pilot/workflow-manifest.js";
import { readSnapshot, type AssertionResult } from "../pilot/workflow-runtime.js";
import { redactSecrets } from "../redact.js";
import type { RunSummary } from "../report.js";
import type { Finding, QaAction } from "../types.js";

/**
 * One QA-lead view of a run, derived only from the run's own artifacts
 * (never from the benchmark answer key, never from anything not recorded).
 * Three separations are the point of this file:
 *  - application finding candidates vs AutoQA/configuration failures vs
 *    unsupported capabilities;
 *  - executed checks vs checks that never ran (a run that executed nothing
 *    is never presented as a pass);
 *  - browser actions vs HTTP check requests vs model decisions vs external
 *    model requests.
 * An assertion mismatch is a *candidate*: the declared expectation may be
 * wrong. Severities are provisional and rule-based, with the rule stated.
 */
export type QaSummary = {
  schemaVersion: 1;
  runId: string;
  application: { profileId: string; name: string; origin: string; environmentKind: string; fingerprint?: string };
  operation: "authentication-only" | "declared-workflows" | "exploration";
  runStatus: RunSummary["status"] | "unknown";
  stopReason?: string;
  verdict: { kind: "no-checks-executed" | "needs-review" | "partial" | "passed-within-scope"; message: string; executedChecks: number; notExecuted: number };
  authentication: { state: "not-required" | "not-attempted" | "failed" | "verified"; detail: string };
  apiAuthentication: { state: "not-configured" | "not-run" | "unsupported" | "session-expired" | "executed-with-run-session"; detail: string; observedMechanism?: AuthMechanismSummary["origins"] };
  workflows: {
    selected: number; attempted: number; completed: number; failed: number; blocked: number; cancelled: number; unsupported: number; notAttempted: number;
    items: WorkflowItem[];
  };
  checks: { declared: number; ran: number; passed: number; mismatched: number; notRun: number };
  findings: {
    applicationCandidates: ApplicationCandidate[];
    autoqaFailures: Array<{ source: string; id: string; kind: string; reason: string }>;
    unsupported: Array<{ source: string; id: string; reason: string }>;
  };
  notAssessed: string[];
  accounting: { browserActions: number; httpCheckRequests: number; modelDecisions: number; externalModelRequests: number | "unknown"; provider: string };
};

type WorkflowItem = {
  id: string; kind?: string; description: string; status: string; reason: string; failureKind?: string | null;
  reproduced?: boolean | null; attempts?: number; assertions: AssertionResult[]; firstAttemptAssertions?: AssertionResult[]; evidenceRef?: string;
};

type ApplicationCandidate = {
  source: "workflow" | "check" | "exploration"; id: string; title: string; reproduced: boolean | null;
  severity: "medium (provisional)" | "low (provisional)" | "unrated"; severityRule: string;
  reproductionSteps: string[]; expectedVsObserved: string[]; evidenceRefs: string[];
};

export type QaSummaryContext = {
  runId: string;
  application: QaSummary["application"];
  operation: QaSummary["operation"];
  authRequired: boolean;
  apiChecksUseRunSession: boolean;
};

const readJson = <T>(path: string): T | undefined => {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) as T : undefined; } catch { return undefined; }
};

const describeTarget = (t: { role?: string; name?: string; label?: string; text?: string; testId?: string } | undefined): string =>
  !t ? "the page" : [t.role, t.name ?? t.label ?? t.text ?? t.testId].filter(Boolean).map((v, i) => i === 1 ? `"${v}"` : v).join(" ");

function describeAction(action: QaAction): string {
  switch (action.type) {
    case "click": return `Click ${describeTarget(action.target)}`;
    case "fill": return `Type "${action.value}" into ${describeTarget(action.target)}`;
    case "select": return `Choose "${action.option}" in ${describeTarget(action.target)}`;
    case "press": return `Press ${action.key}${action.target ? ` in ${describeTarget(action.target)}` : ""}`;
    case "navigate": return `Open ${action.url}`;
    default: return action.type;
  }
}

function reproductionSteps(workflow: DeclaredWorkflow | undefined, authRequired: boolean): string[] {
  if (!workflow?.execution) return [];
  return [
    ...(authRequired ? ["Sign in with the dedicated test account"] : []),
    `Open ${workflow.execution.steps[0]?.pathname ?? workflow.page}`,
    ...workflow.execution.steps.map((s) => describeAction(s.action as QaAction)),
    "Compare the page with the declared expected result",
  ];
}

export function buildQaSummary(runDir: string, context: QaSummaryContext): QaSummary {
  const run = readJson<RunSummary>(join(runDir, "run-summary.json"));
  const auth = readJson<{ status: string; reason?: string }>(join(runDir, "authentication.json"));
  const ledger = readJson<ChecksLedger>(join(runDir, "check-results.json"));
  const checkUsage = readJson<{ requests: number }>(join(runDir, "check-usage.json"));
  const mechanism = readJson<AuthMechanismSummary>(join(runDir, "auth-mechanism.json"));
  const report = readJson<{ findings?: Finding[]; coverage?: { heuristicsExecuted?: number } }>(join(runDir, "report.json"));
  const manifest = (() => { try { return readSnapshot(runDir); } catch { return undefined; } })();

  const findings: QaSummary["findings"] = { applicationCandidates: [], autoqaFailures: [], unsupported: [] };
  const notAssessed: string[] = [];

  // --- Workflows -----------------------------------------------------------
  const records = new Map<string, { status: string; reason: string; evidence?: Record<string, unknown> }>();
  const workflowDir = join(runDir, "workflows");
  if (existsSync(workflowDir)) {
    for (const file of readdirSync(workflowDir).filter((f) => f.endsWith(".json"))) {
      const parsed = readJson<{ workflowId: string; status: string; reason: string; evidence?: Record<string, unknown> }>(join(workflowDir, file));
      if (parsed?.workflowId) records.set(parsed.workflowId, parsed);
    }
  }
  const selected = manifest?.workflows ?? [];
  const tally = { completed: 0, failed: 0, blocked: 0, cancelled: 0, unsupported: 0, notAttempted: 0 };
  const items: WorkflowItem[] = selected.map((workflow) => {
    const record = records.get(workflow.id);
    if (!record) {
      tally.notAttempted++;
      notAssessed.push(`Workflow ${workflow.id}: not attempted`);
      return { id: workflow.id, kind: workflow.kind, description: workflow.description, status: "not-attempted", reason: "No result recorded for this workflow", assertions: [] };
    }
    const evidence = record.evidence ?? {};
    const failureKind = (evidence["failureKind"] as string | null | undefined) ?? null;
    const assertion = evidence["assertion"] as { assertions?: AssertionResult[] } | undefined;
    const firstAttempt = evidence["firstAttempt"] as { assertions?: AssertionResult[] } | undefined;
    const reproduced = (evidence["reproduced"] as boolean | null | undefined) ?? null;
    const status = record.status === "blocked" && failureKind === "cancelled" ? "cancelled" : record.status;
    if (status in tally) tally[status as keyof typeof tally]++;
    const item: WorkflowItem = {
      id: workflow.id, kind: workflow.kind, description: workflow.description, status, reason: record.reason, failureKind,
      ...(reproduced !== null || evidence["attempts"] !== undefined ? { reproduced, attempts: evidence["attempts"] as number } : {}),
      assertions: assertion?.assertions ?? [],
      ...(firstAttempt?.assertions ? { firstAttemptAssertions: firstAttempt.assertions } : {}),
      evidenceRef: `workflows/${workflow.id}.json`,
    };
    if (record.status === "failed" && failureKind === "application-assertion") {
      const mismatches = [...(firstAttempt?.assertions ?? []), ...(assertion?.assertions ?? [])].filter((a) => !a.passed);
      findings.applicationCandidates.push({
        source: "workflow", id: workflow.id, title: `${workflow.description}: declared expectation not met`, reproduced,
        severity: reproduced === true ? "medium (provisional)" : reproduced === false ? "low (provisional)" : "unrated",
        severityRule: reproduced === true
          ? "Mismatch reproduced on a second attempt from a verified starting state in a read-only workflow; user impact and whether the expectation is correct are not established."
          : reproduced === false
            ? "Mismatch did not reproduce on the retry (intermittent); may be timing or data change."
            : "Not retried (budget or reset unavailable), so reproducibility is unknown.",
        reproductionSteps: reproductionSteps(workflow, context.authRequired),
        expectedVsObserved: [...new Map(mismatches.map((m) => [m.assertion, `${m.assertion}: expected ${m.expected}; observed ${m.observed}`])).values()],
        evidenceRefs: [`workflows/${workflow.id}.json`],
      });
    } else if (status === "unsupported" || failureKind === "unsupported") {
      findings.unsupported.push({ source: "workflow", id: workflow.id, reason: record.reason });
      notAssessed.push(`Workflow ${workflow.id}: unsupported`);
    } else if (record.status === "blocked" && status !== "cancelled") {
      findings.autoqaFailures.push({ source: "workflow", id: workflow.id, kind: failureKind ?? "blocked", reason: record.reason });
      notAssessed.push(`Workflow ${workflow.id}: ${failureKind ?? "blocked"}`);
    } else if (status === "cancelled") {
      notAssessed.push(`Workflow ${workflow.id}: cancelled`);
    }
    return item;
  });
  const attempted = items.filter((i) => i.status !== "not-attempted").length;

  // --- Checks --------------------------------------------------------------
  const entries = ledger?.entries ?? [];
  const checks = { declared: entries.length, ran: 0, passed: 0, mismatched: 0, notRun: 0 };
  for (const entry of entries) {
    const executed = entry.ran && entry.classification !== "unsupported";
    if (executed) checks.ran++; else checks.notRun++;
    if (executed && entry.classification === "passed") checks.passed++;
    if (executed && ["confirmed", "needs_review"].includes(entry.classification)) {
      checks.mismatched++;
      findings.applicationCandidates.push({
        source: "check", id: entry.checkId, title: entry.assertion, reproduced: entry.classification === "confirmed" ? true : null,
        severity: "unrated", severityRule: "Declared check expectation not met; the expectation itself may be wrong and impact is not assessed.",
        reproductionSteps: [`Re-run the declared ${entry.kind} check ${entry.checkId}`], expectedVsObserved: [entry.observation], evidenceRefs: entry.evidenceRefs,
      });
    }
    if (!executed) {
      findings.unsupported.push({ source: entry.kind === "api" ? "api-check" : "security-check", id: entry.checkId, reason: entry.blockedReason ?? entry.observation });
      notAssessed.push(`Check ${entry.checkId}: not run`);
    }
  }

  // --- Exploration findings (heuristic mode) -------------------------------
  if (context.operation === "exploration") {
    for (const f of report?.findings ?? []) {
      if (f.reportDisposition === "suppress" || f.status === "rejected") continue;
      const validated = f.status === "validated";
      findings.applicationCandidates.push({
        source: "exploration", id: f.id, title: f.title, reproduced: validated ? f.reproduction.successes > 0 : null,
        severity: validated && f.reportDisposition === "report" ? "medium (provisional)" : "unrated",
        severityRule: validated && f.reportDisposition === "report" ? "Deterministic oracle mismatch reproduced by replay; business impact not assessed." : "Needs human review before any severity is assigned.",
        reproductionSteps: [`Open ${f.pathname}`, ...f.steps.map((s) => describeAction(s.action))],
        expectedVsObserved: [`expected ${f.expected}; observed ${f.actual}`], evidenceRefs: f.evidence,
      });
    }
  }

  // --- Authentication states ----------------------------------------------
  const authentication: QaSummary["authentication"] = !context.authRequired
    ? { state: "not-required", detail: "This profile needs no sign-in." }
    : !auth
      ? { state: "not-attempted", detail: "Authentication was not attempted (the run ended before sign-in)." }
      : auth.status === "success"
        ? { state: "verified", detail: "Post-login URL and visible signal were both verified." }
        : { state: "failed", detail: auth.reason ?? auth.status };

  const sessionEntries = entries.filter((e) => e.kind === "api");
  const apiAuthentication: QaSummary["apiAuthentication"] = (() => {
    const observedMechanism = mechanism?.origins;
    const base = observedMechanism ? { observedMechanism } : {};
    if (!context.authRequired) return { state: "not-configured", detail: "API checks need no session for this profile." };
    if (!sessionEntries.length) return { state: "not-run", detail: "No authenticated API check ran in this run.", ...base };
    if (sessionEntries.some((e) => e.ran && e.session === "run-session" && e.classification !== "unsupported")) return { state: "executed-with-run-session", detail: `API check(s) sent with this run's verified session (${sessionEntries.find((e) => e.sessionAuth)?.sessionAuth ?? "cookie"}).`, ...base };
    if (sessionEntries.some((e) => e.session === "expired")) return { state: "session-expired", detail: "The target rejected the run's session; no further requests were sent.", ...base };
    if (!context.apiChecksUseRunSession) return { state: "unsupported", detail: "Authenticated API checks are not enabled for this profile (apiChecks.useRunSession).", ...base };
    return { state: "unsupported", detail: sessionEntries.find((e) => e.blockedReason)?.blockedReason ?? "No usable session for API checks.", ...base };
  })();

  // --- Verdict -------------------------------------------------------------
  const exploredHeuristics = context.operation === "exploration" ? report?.coverage?.heuristicsExecuted ?? 0 : 0;
  const executedChecks = tally.completed + tally.failed + checks.ran + exploredHeuristics;
  const notExecuted = tally.blocked + tally.cancelled + tally.unsupported + tally.notAttempted + checks.notRun;
  const verdict: QaSummary["verdict"] = executedChecks === 0
    ? { kind: "no-checks-executed", executedChecks, notExecuted, message: context.operation === "authentication-only"
        ? `Authentication ${authentication.state === "verified" ? "was verified" : `is ${authentication.state}`}; no QA checks were executed — this is not a QA pass.`
        : "No checks were executed — this is not a QA pass." }
    : findings.applicationCandidates.length
      ? { kind: "needs-review", executedChecks, notExecuted, message: `${findings.applicationCandidates.length} application finding candidate(s) need human review; ${executedChecks} check(s) executed, ${notExecuted} not executed.` }
      : notExecuted
        ? { kind: "partial", executedChecks, notExecuted, message: `${executedChecks} executed check(s) passed, but ${notExecuted} were not executed — partial result, not a full pass.` }
        : { kind: "passed-within-scope", executedChecks, notExecuted, message: `All ${executedChecks} executed check(s) passed within the declared scope. This does not show the application is free of defects.` };

  if (!selected.length && context.operation !== "exploration") notAssessed.push("No declared workflows were selected");
  if (!entries.length) notAssessed.push("No API or security checks were declared or enabled");
  notAssessed.push("Anything outside the declared workflows, checks and approved origins/paths");

  return {
    schemaVersion: 1,
    runId: context.runId,
    application: context.application,
    operation: context.operation,
    runStatus: run?.status ?? "unknown",
    ...(run?.stopReason ? { stopReason: run.stopReason } : {}),
    verdict,
    authentication,
    apiAuthentication,
    workflows: { selected: selected.length, attempted, ...tally, items },
    checks,
    findings,
    notAssessed,
    accounting: {
      browserActions: run?.actionsPerformed ?? 0,
      httpCheckRequests: checkUsage?.requests ?? 0,
      modelDecisions: run?.modelCalls ?? 0,
      externalModelRequests: run?.usage ? run.usage.explorer.requests + run.usage.critic.requests : "unknown",
      provider: run?.provider ?? "unknown",
    },
  };
}

export function writeQaSummary(runDir: string, context: QaSummaryContext, extraSecrets: readonly string[] = []): QaSummary {
  const summary = buildQaSummary(runDir, context);
  writeFileSync(join(runDir, "qa-summary.json"), redactSecrets(JSON.stringify(summary, null, 2), extraSecrets), "utf-8");
  return summary;
}
