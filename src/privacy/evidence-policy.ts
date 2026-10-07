import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templatePath } from "../auth/api-observer.js";
import type { AppConfig } from "../config.js";
import type { ApplicationMap } from "../mapping/types.js";
import { redactSecrets } from "../redact.js";
import type { ConsoleRecord, Finding, NetworkRecord, PageErrorRecord, RecordedStep } from "../types.js";

/**
 * Evidence policy (docs/privacy/EVIDENCE_POLICY.md).
 *
 * "minimal" (default for every non-fixture target): persisted evidence keeps
 * identifiers, approved route templates, roles, counts, verdicts, reason
 * codes and revisions. Text discovered on the tested application -- control
 * and link names, titles, hrefs, query strings, console and error text,
 * input values, response bodies -- is never written. Approved configuration
 * text (declared workflow targets, descriptions) may stay in local files.
 *
 * "diagnostic" (local fixtures, or a profile that opts in explicitly): the
 * pre-Phase-14 behaviour, unchanged, so the canonical benchmark and the
 * challenge corpus keep their artifacts.
 *
 * Minimizers select fields by type BEFORE serialization; they never
 * serialize first and scrub afterwards. A minimizer that throws produces an
 * explicit failure marker, never the raw value.
 */
export const EVIDENCE_POLICY_VERSION = "evidence-policy/1" as const;
export type EvidenceMode = "minimal" | "diagnostic";
export type EvidencePolicy = { version: typeof EVIDENCE_POLICY_VERSION; mode: EvidenceMode; routeTemplates: readonly string[] };

export const POLICY_FILE = "evidence-policy.json";

/** Absent policy (the fixture CLI path) means diagnostic: those runs only ever target the local fixture. */
export function policyOf(config: Pick<AppConfig, "evidencePolicy">): EvidencePolicy {
  return config.evidencePolicy ? { version: EVIDENCE_POLICY_VERSION, mode: config.evidencePolicy.mode, routeTemplates: config.evidencePolicy.routeTemplates ?? [] } : { version: EVIDENCE_POLICY_VERSION, mode: "diagnostic", routeTemplates: [] };
}

export const isMinimal = (policy: EvidencePolicy | undefined): boolean => policy?.mode === "minimal";

/** Categories minimal mode never persists, stated in every run's policy file. */
export const MINIMAL_OMISSIONS = [
  { category: "page-text", reason: "Control and link names, labels, titles and visible text discovered on the application." },
  { category: "url-details", reason: "Query strings, fragments and path segments outside approved route templates." },
  { category: "console-and-errors", reason: "Console messages and error text (counts and error classes are kept)." },
  { category: "entered-and-observed-values", reason: "Values typed into or read from controls and query parameters (verdicts are kept)." },
  { category: "response-bodies", reason: "API response bodies (structure-only evidence is kept)." },
  { category: "binary-captures", reason: "Screenshots and traces are not captured." },
] as const;

/** Run-level record of the policy that wrote this run's evidence; a run without it is legacy / privacy-unclassified. */
export function writePolicyFile(runDir: string, policy: EvidencePolicy, environmentKind: string): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, POLICY_FILE), JSON.stringify({
    schemaVersion: 1,
    policyVersion: policy.version,
    mode: policy.mode,
    environmentKind,
    omittedCategories: policy.mode === "minimal" ? MINIMAL_OMISSIONS : [],
    generationFailures: [],
  }, null, 2), "utf-8");
}

export type RunPolicyRecord = { schemaVersion: 1; policyVersion: string; mode: EvidenceMode; environmentKind: string; omittedCategories: Array<{ category: string; reason: string }>; generationFailures: Array<{ category: string; reasonCode: string; at: string }> };

/** The run's policy record, or undefined for a legacy (privacy-unclassified) run. */
export function readPolicyFile(runDir: string): RunPolicyRecord | undefined {
  const path = join(runDir, POLICY_FILE);
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf-8")) as RunPolicyRecord; } catch { return undefined; }
}

function recordFailure(runDir: string, category: string): void {
  const record = readPolicyFile(runDir);
  if (!record) return;
  record.generationFailures.push({ category, reasonCode: "evidence-generation-failed", at: new Date().toISOString() });
  writeFileSync(join(runDir, POLICY_FILE), JSON.stringify(record, null, 2), "utf-8");
}

/**
 * Builds and writes one evidence file. If building the minimized value
 * throws, a failure marker is written instead and the run's policy file
 * records it; the raw value is never written as a fallback.
 */
export function writeMinimizedJson(runDir: string, path: string, category: string, build: () => unknown, extraSecrets: readonly string[] = []): void {
  let value: unknown;
  try {
    value = build();
  } catch {
    value = { evidenceGenerationFailed: true, category, reasonCode: "evidence-generation-failed", policyVersion: EVIDENCE_POLICY_VERSION };
    recordFailure(runDir, category);
  }
  writeFileSync(path, redactSecrets(JSON.stringify(value, null, 2), extraSecrets), "utf-8");
}

/** Test hook: makes the named category's minimizer throw, to prove there is no raw fallback. */
let failingCategory: string | undefined;
export function __failMinimizerForTest(category: string | undefined): void { failingCategory = category; }
export function assertMinimizerAllowed(category: string): void {
  if (failingCategory === category) throw new Error(`forced minimizer failure for ${category}`);
}

/** A URL or pathname reduced to an approved/sanitized route template: no query, no fragment, masked segments. */
export function routeOf(urlOrPath: string, policy: EvidencePolicy, sameOrigin?: string): string {
  try {
    const url = new URL(urlOrPath, "http://route.invalid");
    if (sameOrigin && url.origin !== "http://route.invalid" && url.origin !== sameOrigin) return "<other-origin>";
    return templatePath(url.pathname, policy.routeTemplates);
  } catch {
    return "<unparseable>";
  }
}

/** Application map with run-local references in place of names, labels, titles and hrefs. */
export function minimizeApplicationMap(map: ApplicationMap, policy: EvidencePolicy): unknown {
  assertMinimizerAllowed("application-map");
  const refByPage = new Map(map.pages.map((p, i) => [p.id, `P${i + 1}`]));
  return {
    policyVersion: policy.version,
    mode: "minimal",
    pages: map.pages.map((page, i) => ({
      pageRef: `P${i + 1}`,
      pathTemplate: routeOf(page.pathname, policy),
      firstSeenAt: page.firstSeenAt,
      controls: page.controls.map((c, j) => ({ ref: `P${i + 1}.C${j + 1}`, role: c.role ?? null, widgetType: c.widgetType, required: c.required ?? false, enabled: c.enabled ?? true })),
      links: page.links.map((l, j) => ({ ref: `P${i + 1}.L${j + 1}`, sameOrigin: l.sameOrigin, targetPathTemplate: l.sameOrigin ? routeOf(l.href, policy) : "<other-origin>" })),
      counts: { controls: page.controls.length, links: page.links.length },
      testedHeuristics: page.testedHeuristics.length,
    })),
    edges: map.edges.map((e) => ({ from: refByPage.get(e.fromPageId) ?? "?", to: refByPage.get(e.toPageId) ?? "?", actionType: e.action.type })),
    omissions: ["page titles", "full URLs, query strings and fragments", "control names and labels", "link text and hrefs", "edge labels"],
  };
}

/** A recorded step without names, labels, typed values or full URLs. */
export function minimizeStep(step: RecordedStep, policy: EvidencePolicy): unknown {
  const action = step.action as { type: string; target?: { role?: string; pathname?: string; testId?: string }; url?: string };
  return {
    number: step.number,
    type: action.type,
    ...(action.target ? { targetRole: action.target.role ?? null, ...(action.target.pathname ? { targetPathTemplate: routeOf(action.target.pathname, policy) } : {}) } : {}),
    ...(action.type === "navigate" && action.url ? { pathTemplate: routeOf(action.url, policy) } : {}),
    ...(step.outcome ? { outcome: step.outcome } : {}),
    omitted: "target names, labels and entered values",
  };
}

export function minimizeConsole(records: ConsoleRecord[]): unknown {
  return { count: records.length, levels: countBy(records.map((r) => r.type)), omitted: "message text" };
}

export function minimizePageErrors(records: PageErrorRecord[]): unknown {
  return { count: records.length, errorClasses: countBy(records.map((r) => /^([A-Z][A-Za-z]*Error)\b/.exec(r.message)?.[1] ?? "unclassified")), omitted: "error messages" };
}

export function minimizeNetwork(records: NetworkRecord[], policy: EvidencePolicy, origin?: string): unknown {
  return { count: records.length, requests: records.slice(0, 200).map((r) => ({ method: r.method, pathTemplate: routeOf(r.url, policy, origin), status: r.status ?? null, resourceType: r.resourceType ?? null })), omitted: "query strings, fragments and request/response contents" };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Leading machine code of a stop reason ("AUTH_FAILED: …" → "AUTH_FAILED"); free text is not kept. */
export function stopReasonCode(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return /^([A-Z][A-Z_]{2,40})\b/.exec(reason)?.[1] ?? "UNCLASSIFIED";
}

/**
 * A finding as persisted in minimal mode. In-memory findings (used for
 * validation replay, dedup and grouping) are unchanged; only what is
 * written is reduced. The oracle's own expected/actual and details, the
 * critic's free text and step names/values are omitted; the fixed title,
 * statuses, reproduction counts and identities are kept.
 */
export function minimizeFinding(finding: Finding, policy: EvidencePolicy): unknown {
  assertMinimizerAllowed("finding");
  return {
    id: finding.id,
    title: finding.title,
    ...(finding.displayTitle ? { displayTitle: finding.displayTitle } : {}),
    status: finding.status,
    category: finding.category,
    pageId: finding.pageId,
    pathTemplate: routeOf(finding.pathname, policy),
    oracleId: finding.oracle.oracleId,
    ...(finding.heuristicId ? { heuristicId: finding.heuristicId } : {}),
    ...(finding.controlKey !== undefined ? { controlRole: finding.controlKey.split(":")[0] || null } : {}),
    steps: finding.steps.map((s) => minimizeStep(s, policy)),
    ...(finding.prerequisitePrefix?.length ? { prerequisitePrefix: finding.prerequisitePrefix.map((s) => minimizeStep(s, policy)) } : {}),
    reproduction: finding.reproduction,
    occurrenceCount: finding.occurrenceCount,
    evidence: finding.evidence,
    evidenceLevel: finding.evidenceLevel,
    reportDisposition: finding.reportDisposition,
    ...((finding as { groupId?: string }).groupId ? { groupId: (finding as { groupId?: string }).groupId } : {}),
    ...(finding.critic ? { critic: { verdict: finding.critic.verdict, confidence: finding.critic.confidence, provider: finding.critic.provider, omitted: "critic summary text" } } : {}),
    omitted: ["full URL and query", "oracle expected/actual text and details", "control and step names, labels and entered values"],
  };
}

/**
 * Stop reasons whose text is written by AutoQA itself (codes, counts and
 * structured sub-reasons) are kept; any other reason, e.g. INTERNAL_ERROR
 * with a stack that may quote page content, is reduced to its code.
 */
const AUTOQA_AUTHORED_STOP_CODES = new Set(["AUTH_FAILED", "CANCELLED", "BUDGET_EXHAUSTED", "SESSION_EXPIRED", "COMPLETED", "NO_CANDIDATES", "MAX_PAGES", "DURATION_EXCEEDED", "PRECONDITION_FAILED"]);
export function minimalStopReason(reason: string | undefined, policy: EvidencePolicy): string | undefined {
  if (!reason || !isMinimal(policy)) return reason;
  const code = stopReasonCode(reason)!;
  return AUTOQA_AUTHORED_STOP_CODES.has(code) ? reason : `${code}: details omitted under ${policy.version}`;
}

/** The minimized value, or a failure marker (recorded in the run's policy file) -- never the raw value. */
export function guardMinimized(build: () => unknown, category: string, runDir: string): unknown {
  try {
    return build();
  } catch {
    recordFailure(runDir, category);
    return { evidenceGenerationFailed: true, category, reasonCode: "evidence-generation-failed", policyVersion: EVIDENCE_POLICY_VERSION };
  }
}

type AssertionLike = { id?: string; assertion: string; expected: string; observed: string; passed: boolean };

/**
 * One workflow assertion as persisted in minimal mode: the verdict and the
 * approved expectation are kept; an observed value read from the page
 * (query value, control value, a path with data segments) is replaced by
 * a verdict-preserving statement. A failure stays a failure.
 */
export function minimizeAssertion(a: AssertionLike, policy: EvidencePolicy): AssertionLike {
  const id = a.id ?? "";
  if (id === "url") return { ...a, observed: routeOf(a.observed, policy) };
  if (id.startsWith("query:") || id === "inputValue") {
    const kept = a.observed === "(absent)" || a.observed === "(control not found)";
    return { ...a, observed: a.passed ? "matches the expected value (value omitted)" : kept ? a.observed : "differs from the expected value (value omitted)" };
  }
  return a;
}

/** Workflow runner evidence in minimal mode: assertions minimized, URL as a route template, steps without names or values. */
export function minimizeWorkflowEvidence(evidence: unknown, policy: EvidencePolicy): unknown {
  assertMinimizerAllowed("workflow");
  if (!evidence || typeof evidence !== "object") return evidence;
  const e = evidence as Record<string, unknown> & { assertion?: { assertions?: AssertionLike[] }; firstAttempt?: { assertions?: AssertionLike[] }; url?: string; steps?: RecordedStep[]; reset?: { detail?: string } };
  const mapAssertions = <T extends { assertions?: AssertionLike[] } | undefined>(block: T): T => block && Array.isArray(block.assertions) ? { ...block, assertions: block.assertions.map((a) => minimizeAssertion(a, policy)) } : block;
  const resetPrefix = "Reset navigation ended on ";
  return {
    ...e,
    ...(e.assertion ? { assertion: mapAssertions(e.assertion) } : {}),
    ...(e.firstAttempt ? { firstAttempt: mapAssertions(e.firstAttempt) } : {}),
    ...(typeof e.url === "string" ? { url: routeOf(e.url, policy) } : {}),
    ...(Array.isArray(e.steps) ? { steps: e.steps.map((s) => minimizeStep(s, policy)) } : {}),
    ...(e.reset?.detail?.startsWith(resetPrefix) ? { reset: { ...e.reset, detail: resetPrefix + routeOf(e.reset.detail.slice(resetPrefix.length), policy) } } : {}),
    evidencePolicy: policy.version,
  };
}

const PHASE_TEXT: Record<string, string> = {
  "checking-setup": "Checking setup", "signing-in": "Signing in", exploring: "Running", reproducing: "Re-checking a candidate finding",
  reviewing: "Reviewing results", completed: "Run finished", stopped: "Stopped", failed: "Failed",
};

/**
 * A progress event as sent to the UI (SSE and /status) under minimal
 * evidence: counters unchanged, `detail` reduced to phase-level text. A
 * terminal event keeps an AutoQA-authored stop reason (code and structured
 * sub-reason); page-derived text such as candidate descriptions, oracle
 * output or error stacks is never sent.
 */
/** Fixed progress texts written by AutoQA itself (no page content), kept as they are. */
const AUTOQA_STATIC_DETAILS = new Set(["Running declared API and security checks; browser exploration has finished.", "Run finished."]);

export function minimalProgressEvent<E extends { phase: string; detail: string }>(event: E): E {
  const code = stopReasonCode(event.detail);
  const terminal = event.phase === "completed" || event.phase === "stopped" || event.phase === "failed";
  const detail = AUTOQA_STATIC_DETAILS.has(event.detail) || (terminal && code && AUTOQA_AUTHORED_STOP_CODES.has(code))
    ? event.detail
    // An action event keeps its "→" marker (an action is executing) without the candidate's description or intent.
    : event.detail.startsWith("→") ? `→ Performing an action (details omitted under ${EVIDENCE_POLICY_VERSION})`
    : `${PHASE_TEXT[event.phase] ?? "Running"} (details omitted under ${EVIDENCE_POLICY_VERSION})`;
  return { ...event, detail };
}

/** The evidence mode a profile's runs use: explicit choice, else minimal for every non-fixture target. */
export function profileEvidenceMode(profile: { evidencePolicy?: EvidenceMode | undefined; target: { environmentKind: string } }): EvidenceMode {
  return profile.evidencePolicy ?? (profile.target.environmentKind === "local-fixture" ? "diagnostic" : "minimal");
}
