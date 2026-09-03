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

export type InteractiveElement = {
  role?: string;
  name?: string;
  label?: string;
  type?: string;
  visible: boolean;
  enabled?: boolean;
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
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
  };
  visibleText: string;
  interactiveElements: InteractiveElement[];
  consoleMessages: ConsoleRecord[];
  pageErrors: PageErrorRecord[];
  networkRequests: NetworkRecord[];
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
