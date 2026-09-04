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

export type FindingCategory = "console" | "runtime" | "network" | "validation" | "state" | "functional";

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
  reproduction: {
    attempts: number;
    successes: number;
  };
  /** Run-level dedup count (§25) -- starts at 1, incremented instead of creating a duplicate finding. */
  occurrenceCount: number;
  evidence: string[];
};

/**
 * Emitted by every layer of off-origin navigation defense (§17-18). Never
 * an application defect — page content can never cause a genuine finding
 * merely by attempting to navigate away.
 */
export type SafetyEvent = {
  code: "SAFETY_NAVIGATION_BLOCKED";
  url: string;
  mechanism: "route" | "post-action" | "framenavigated" | "popup";
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
