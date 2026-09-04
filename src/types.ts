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

export type ExplorerInput = {
  observation: Observation;
  previousActions: RecordedStep[];
  remainingActions: number;
};

export type ExplorerDecision = {
  action: QaAction;
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

export type Finding = {
  id: string;
  title: string;
  status: FindingStatus;
  url: string;
  expected: string;
  actual: string;
  oracle: OracleResult;
  steps: RecordedStep[];
  reproduction: {
    attempts: number;
    successes: number;
  };
  evidence: string[];
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
