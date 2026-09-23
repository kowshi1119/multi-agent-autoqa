export type ElementTarget = {
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  testId?: string;
};

export type QaAction =
  | { type: "click"; target: ElementTarget }
  | { type: "fill"; target: ElementTarget; value: string }
  | { type: "press"; target?: ElementTarget; key: string }
  | { type: "reload" }
  | { type: "navigate"; url: string }
  | { type: "wait"; milliseconds: number }
  | { type: "stop"; reason: string };

export type RecordedStep = {
  number: number;
  action: QaAction;
  testingIntent?: string;
  timestamp: string;
  /**
   * §7b fix (2026-09-14 addendum): populated from the actual executeAction()
   * result at the point this step is recorded -- lets computePrerequisitePrefix()
   * (src/orchestrator/orchestrator.ts) exclude blocked/failed steps from a
   * finding's replay prerequisites, rather than blindly taking the last N
   * recorded steps regardless of whether they actually succeeded. Optional
   * because older/mock-produced steps may not set it.
   */
  outcome?: "success" | "blocked" | "agent_action_failed";
};

export type WidgetType =
  | "text_field"
  | "email_field"
  | "password_field"
  | "number_field"
  | "search_field"
  | "textarea"
  | "button"
  | "submit_button"
  | "link"
  | "checkbox"
  | "radio"
  | "select"
  | "dialog"
  | "unknown";

/** Execution-time policy classification for a candidate action (§48-49). */
export type ActionRisk = "safe" | "state_changing" | "destructive";

/** A QaHeuristic's own self-declared risk (§13) — a distinct enum from ActionRisk; do not conflate. */
export type HeuristicRisk = "safe" | "moderate" | "destructive";

export type InteractiveElement = {
  role?: string;
  name?: string;
  label?: string;
  type?: string;
  widgetType: WidgetType;
  required?: boolean;
  visible: boolean;
  enabled?: boolean;
};

export type FormSummary = {
  formIndex: number;
  action?: string;
  method?: string;
  fields: InteractiveElement[];
  submitControl?: InteractiveElement;
};

export type LinkSummary = {
  href: string;
  text?: string;
  sameOrigin: boolean;
};

export type DialogRecord = {
  dialogType: string;
  message: string;
  action: "dismissed";
  timestamp: string;
};

export type ConsoleRecord = {
  type: string;
  text: string;
  timestamp: string;
};

export type PageErrorRecord = {
  message: string;
  timestamp: string;
};

export type NetworkRecord = {
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  timestamp: string;
};

export type Observation = {
  timestamp: string;
  page: {
    url: string;
    title: string;
    /** Normalized via src/mapping/state-signature.ts#normalizePathname — see that module for the exact rule. */
    pathname: string;
  };
  viewport: {
    width: number;
    height: number;
  };
  visibleText: string;
  interactiveElements: InteractiveElement[];
  forms: FormSummary[];
  links: LinkSummary[];
  consoleMessages: ConsoleRecord[];
  pageErrors: PageErrorRecord[];
  networkRequests: NetworkRecord[];
  dialogs: DialogRecord[];
  /** sha256(pathname + "|" + sortedControlKeys + "|" + visibleText.slice(0,300)) — see state-signature.ts. */
  stateSignature: string;
  screenshotPath?: string;
};

/**
 * A candidate action the Planner offers to the Explorer. `id` is what the
 * model actually chooses (see ExplorerDecision, wired up in M6) — never a
 * raw action — which keeps the model's response surface small and closed.
 */
export type TestCandidate = {
  workflowId?: string;
  id: string;
  kind: "heuristic" | "navigation" | "control";
  heuristicId?: string;
  controlKey?: string;
  description: string;
  risk: ActionRisk;
  actions: QaAction[];
  /** Present for kind:"heuristic" — the exact §14 tracking key for this (page, control, heuristic) combo. */
  trackingKey?: string;
};

export type HeuristicResult = {
  heuristicId: string;
  executed: boolean;
  actions: RecordedStep[];
  notes?: string;
};

/**
 * The model picks only from `candidates` (by id) — it never invents a raw
 * action. This keeps the response surface small and closed, which also
 * materially lowers invalid-JSON risk for a real provider.
 */
export type ExplorerInput = {
  observation: Observation;
  candidates: TestCandidate[];
  recentActions: RecordedStep[];
  remainingActions: number;
  remainingModelCalls: number;
  remainingDurationMs: number;
  /**
   * This run's transient login credentials (2026-09-15 fix) -- Observation
   * itself now stays raw/operational (see observation.ts), so
   * formatUserMessage() applies redaction to observation.page.url/.title
   * itself, right where they're rendered into the outgoing prompt.
   */
  extraSecrets?: readonly string[];
};

export type ExplorerDecision = {
  candidateId: string;
  testingIntent: string;
  reason: string;
};

export type OracleResult = {
  oracleId: string;
  suspicious: boolean;
  expected: string;
  actual: string;
  details?: Record<string, unknown>;
};

export type FindingStatus =
  | "suspected"
  | "validating"
  | "validated"
  | "rejected"
  | "needs_human";

export type FindingCategory = "console" | "runtime" | "network" | "validation" | "state" | "functional" | "api" | "security";

/**
 * L1 = deterministic domain/business invariant (very strong, e.g.
 * duplicate-request, ui-api-consistency). L2 = explicit requirement
 * violation (strong). L3 = runtime/network failure (strong anomaly
 * evidence, not automatic proof of a defect — page-error/http-failure/
 * console-error). L4 = deterministic standards/a11y violation (unused in
 * Phase 2). L5 = repeatable UX/visual anomaly (unused in Phase 2). L6 =
 * AI-suspicion-only — never auto-reported regardless of critic confidence.
 * Code assigns this from oracleId; the Critic only ever receives it, never
 * chooses its own (see src/critic/evidence-level.ts).
 */
export type EvidenceLevel = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";

/**
 * Independent of FindingStatus: status answers "did this reproduce?",
 * disposition answers "should we report it as a defect?" A validated
 * (reproducible) finding can still be suppress/needs_human.
 */
export type ReportDisposition = "report" | "suppress" | "needs_human";

export type CriticVerdict = "valid" | "invalid" | "needs_human";

/**
 * A scoped product-behavior fact available to QA (never a seeded-defect
 * answer key — see fixture/ground-truth.json vs fixture/requirements.json).
 * `triggerRequestPathname`/`expectedVisibleText` are optional machine-
 * checkable hints a deterministic matcher (MockCriticProvider) can compare
 * against observed evidence — not natural-language parsing.
 */
export type RequirementRule = {
  id: string;
  pathname: string;
  description: string;
  triggerRequestPathname?: string;
  expectedVisibleText?: string;
};

/**
 * What a Critic call actually receives — scoped to the relevant pathname,
 * never the full rule set (see scopeRequirements). Includes the matcher
 * hint fields (triggerRequestPathname/expectedVisibleText): these are
 * still general behavioral facts ("if X fails, UI should show Y"), not a
 * seeded-defect answer key, so there's nothing to strip — ground truth is
 * a structurally separate file/type entirely (see GroundTruthDefect in
 * src/reporting/benchmark.ts), never reachable from this type.
 */
export type RequirementContext = RequirementRule;

export type CriticFindingSummary = {
  title: string;
  category: FindingCategory;
  pathname: string;
  expected: string;
  actual: string;
  controlKey?: string;
};

export type SanitizedConsoleEvidence = { type: string; text: string };
export type SanitizedNetworkEvidence = { method: string; pathname: string; status?: number };
export type SanitizedPageErrorEvidence = { message: string };

/**
 * "representative-success": the finding's representative evidence comes
 * from a Validator attempt that actually reproduced it (matched its
 * failure signature). "diagnostic-no-success": no attempt reproduced it,
 * and the evidence shown is the last attempt's snapshot, kept purely as a
 * diagnostic, not proof of reproduction. Defined here (not in
 * validator.ts) so both validator.ts and types.ts's own CriticInput can
 * reference it without a circular import.
 */
export type EvidenceCompleteness = "representative-success" | "diagnostic-no-success";

/**
 * What the Critic sees. Deliberately excludes API keys/passwords/cookies/
 * Authorization headers/raw trace bytes/storage state/ground truth/hidden
 * model reasoning/the benchmark answer — only the minimum evidence needed
 * to judge whether a reproducible anomaly is a genuine defect.
 */
export type CriticInput = {
  finding: CriticFindingSummary;
  evidenceLevel: EvidenceLevel;
  requirementContext?: RequirementContext[];
  reproduction: { attempts: number; successes: number };
  oracle: OracleResult;
  evidence: {
    console: SanitizedConsoleEvidence[];
    /** Discloses how much console evidence was actually captured vs. shown -- missing evidence must never look like an observed-empty list. */
    consoleScope: { totalCaptured: number; included: number; omitted: number };
    network: SanitizedNetworkEvidence[];
    /** matchedForTriggeringEndpoint is a count among totalPageRequests, never a substitute denominator for it. */
    networkScope: { totalPageRequests: number; matchedForTriggeringEndpoint: number; included: number; omitted: number };
    pageErrors: SanitizedPageErrorEvidence[];
    screenshotPaths: string[];
    traceAvailable: boolean;
    /**
     * Deliberate extension beyond the spec's literal evidence list: without
     * some rendered-text signal, the Critic has no way to confirm the UI
     * actually showed the documented expected message (or a forbidden
     * success message) — necessary for both the false-positive challenge
     * and the ui-api-consistency scenario to be judgeable at all. Redacted,
     * truncated (see src/critic/critic-runner.ts), never raw HTML.
     */
    uiTextExcerpt?: string;
    /** Which Validator attempt this evidence bundle actually came from, and whether it represents a genuine reproduction or only a diagnostic snapshot. */
    attemptScope: { representativeAttempt: number; totalAttempts: number; completeness: EvidenceCompleteness };
  };
  environment: {
    targetEnvironment: string;
    browser: string;
    pathname: string;
  };
};

export type CriticDecision = {
  verdict: CriticVerdict;
  confidence: number;
  summary: string;
  evidenceReferences: string[];
  alternativeExplanation?: string;
  missingEvidence: string[];
  requirementConflict?: string;
};

export type CriticArtifact = CriticDecision & {
  provider: string;
  model?: string;
};

export type Finding = {
  id: string;
  title: string;
  status: FindingStatus;
  category: FindingCategory;
  pageId: string;
  url: string;
  /**
   * Normalized pathname (see mapping/state-signature.ts#normalizePathname),
   * stored at creation time rather than reparsed from `url` later -- this
   * is the exact tuple half used by the dedup key (§25) and the benchmark
   * matcher (§35), both keyed on (oracleId, pathname).
   */
  pathname: string;
  expected: string;
  actual: string;
  oracle: OracleResult;
  heuristicId?: string;
  /** The affected control's normalized key (role:name/role:label/role:), "" if none. Used by the dedup key (§25). */
  controlKey?: string;
  /**
   * The triggering candidate's own actions only -- NOT the full run
   * history. Validator.validate() does `page.goto(finding.url)` then
   * replays `steps` verbatim; scoping this to one candidate's actions is
   * what lets exploration continue across many pages while validation
   * still works unmodified (a spec deviation from the illustrative Finding
   * type, which omits `steps` entirely -- necessary since replay is
   * otherwise impossible).
   */
  steps: RecordedStep[];
  /**
   * (Phase 4 continuation, §4b) A short, deterministic sequence of steps
   * already executed earlier in the SAME exploration cycle, leading from
   * the session's starting point to the page/state `steps` was triggered
   * from -- populated only for authenticated real-target profiles where a
   * client-state-dependent scenario (e.g. list -> filter -> trigger) is
   * plausible. Replayed BEFORE `steps` on a fresh session (see
   * Validator.validate()), never a general shortest-path search across
   * the whole app graph. Excludes credentials by construction: captured
   * from already-executed QaActions, which never carry secrets (the
   * existing `<QA_PASSWORD>`-placeholder convention). Absent (or empty)
   * for a fixture profile / a finding with no real prerequisite --
   * replay behavior there is unchanged.
   */
  prerequisitePrefix?: RecordedStep[];
  reproduction: {
    attempts: number;
    successes: number;
  };
  /** Run-level dedup count (§25) -- starts at 1, incremented instead of creating a duplicate finding. */
  occurrenceCount: number;
  evidence: string[];
  /** Code-assigned from oracleId (never chosen by the Critic) -- see src/critic/evidence-level.ts. */
  evidenceLevel: EvidenceLevel;
  /** Independent of `status` -- see ReportDisposition doc comment. Computed by src/critic/disposition.ts. */
  reportDisposition: ReportDisposition;
  /** Absent when the critic is disabled (Condition-A/Phase-1 parity) or never ran (validation didn't reach "validated"). */
  critic?: {
    verdict: CriticVerdict;
    confidence: number;
    summary: string;
    provider: string;
    model?: string;
    /** Set when the critic's stated facts contradicted deterministic evidence (CRITIC_EVIDENCE_CONTRADICTION) or an L1 invariant conflicted with an "invalid" verdict. */
    criticEvidenceConflict?: boolean;
    /** Surfaced from CriticDecision.requirementConflict (see critic.json) so cross-finding grouping (src/grouping/) can fingerprint by requirement scope without re-reading evidence files. */
    requirementConflict?: string;
  };
};

/**
 * Emitted by every layer of off-origin navigation defense (§17-18), plus
 * (Phase 4) real-target action-policy denials (src/safety/action-policy.ts).
 * Never an application defect — page content can never cause a genuine
 * finding merely by attempting to navigate away or by a denied action
 * being denied.
 */
export type SafetyEvent =
  | {
      code: "SAFETY_NAVIGATION_BLOCKED";
      url: string;
      mechanism: "route" | "post-action" | "framenavigated" | "popup";
      timestamp: string;
    }
  | {
      code: "ACTION_POLICY_DENIED";
      reason: string;
      mechanism: "execute-action" | "route";
      timestamp: string;
    };

/**
 * Distinguishes an agent/tooling mistake (bad locator, timeout) from a
 * genuine application defect. Locator failures must never be reported as
 * findings — see AGENT_ACTION_FAILED handling in the executor.
 */
export type ActionExecutionResult =
  | { outcome: "success" }
  | { outcome: "agent_action_failed"; reason: string }
  | { outcome: "blocked"; reason: string };
