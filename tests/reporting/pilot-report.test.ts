import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseProfile } from "../../src/profiles/schema.js";
import { buildPilotSummary } from "../../src/reporting/pilot-report.js";
import type { QaReport } from "../../src/reporting/qa-report.js";
import { summarizeDeclaredWorkflows, type WorkflowManifest, type WorkflowStatusFile } from "../../src/pilot/workflow-manifest.js";
import type { Finding } from "../../src/types.js";

function orangehrmProfile() {
  return parseProfile({
    schemaVersion: 1,
    id: "orangehrm-test",
    name: "Test OrangeHRM",
    target: { url: "http://localhost:8080/web/index.php/dashboard/index", environmentKind: "self-hosted-real-app" },
    navigation: { allowedOrigins: ["http://localhost:8080"], allowedPathPrefixes: ["/web/index.php"] },
    resources: { allowedApiOrigins: ["http://localhost:8080"], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate", "search"] },
    auth: {
      mode: "form-login",
      loginUrl: "http://localhost:8080/web/index.php/auth/login",
      usernameField: { label: "Username" },
      passwordField: { label: "Password" },
      submitControl: { role: "button", name: "Login" },
      successUrlPattern: ".*dashboard.*",
      authenticatedSignal: { role: "heading", name: "Dashboard" },
    },
    provider: {
      explorer: { provider: "mock" },
      critic: { enabled: true, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
      providerTimeoutMs: 30000,
    },
    limits: { maxActions: 40, maxModelCalls: 12, maxPages: 5, maxFindings: 10, maxDurationMs: 300000, maxCriticCalls: 6 },
  });
}

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "FINDING-001",
    title: "t",
    status: "validated",
    category: "network",
    pageId: "PAGE-001",
    url: "http://localhost:8080/web/index.php/pim/viewEmployeeList",
    pathname: "/web/index.php/pim/viewEmployeeList",
    expected: "e",
    actual: "a",
    oracle: { oracleId: "http-failure", suspicious: true, expected: "e", actual: "a" },
    steps: [],
    reproduction: { attempts: 3, successes: 3 },
    occurrenceCount: 1,
    evidence: [],
    evidenceLevel: "L3",
    reportDisposition: "report",
    ...overrides,
  };
}

function report(findings: Finding[]): QaReport {
  return {
    runId: "RUN-TEST",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: "completed",
    target: { url: "http://localhost:8080/web/index.php/dashboard/index", environment: "self-hosted-real-app" },
    provider: { name: "mock" },
    applicationMap: { pages: [], edges: [] },
    coverage: { pagesDiscovered: 3, pagesVisited: 3, interactiveControlsDiscovered: 12, heuristicsApplicable: 8, heuristicsExecuted: 6, heuristicCoverage: 0.75 },
    findings,
    groups: [],
    oracleBreakdown: {},
    reportDispositionBreakdown: { report: 0, suppress: 0, needs_human: 0 },
    budget: { maxActions: 40, maxModelCalls: 12, maxPages: 5, maxFindings: 10, maxDurationMs: 300000, maxCriticCalls: 6, actionsUsed: 30, modelCallsUsed: 10, pagesUsed: 3, findingsUsed: findings.length, durationMs: 60000, criticCallsUsed: findings.length },
    tracePolicy: "n/a",
    safetyEventCount: 0,
    usage: {
      explorer: { requests: 5, tokenUsage: null },
      critic: { requests: findings.length, tokenUsage: null },
      estimatedCostUsd: null,
      costDisclosure: "test fixture",
    },
  };
}

describe("buildPilotSummary (Phase 4 Milestone C)", () => {
  it("renders precision/recall/F1 as N/A with a reason, never a fabricated number", () => {
    const summary = buildPilotSummary(report([finding({})]), orangehrmProfile());
    expect(summary.detection.precision).toBe("N/A");
    expect(summary.detection.recall).toBe("N/A");
    expect(summary.detection.f1).toBe("N/A");
    expect(summary.detection.reason.length).toBeGreaterThan(0);
  });

  it("humanAcceptance defaults to unavailable with a real reason -- never fabricates participation", () => {
    const summary = buildPilotSummary(report([]), orangehrmProfile());
    expect(summary.humanAcceptance.status).toBe("unavailable");
  });

  it("zero findings on an unmodified target renders as a valid, non-alarming zero", () => {
    const summary = buildPilotSummary(report([]), orangehrmProfile());
    expect(summary.findings.reportable).toBe(0);
    expect(summary.findings.needsReview).toBe(0);
  });

  it("buckets findings by disposition/status correctly", () => {
    const summary = buildPilotSummary(
      report([
        finding({ id: "F1", reportDisposition: "report", status: "validated" }),
        finding({ id: "F2", reportDisposition: "needs_human", status: "needs_human" }),
        finding({ id: "F3", reportDisposition: "suppress", status: "validated" }),
        finding({ id: "F4", reportDisposition: "needs_human", status: "rejected" }),
      ]),
      orangehrmProfile()
    );
    expect(summary.findings.reportable).toBe(1);
    expect(summary.findings.suppressed).toBe(1);
    expect(summary.findings.notReproduced).toBe(1);
  });

  it("reuses the existing heuristic coverage counters for pages rather than inventing untracked ones", () => {
    const summary = buildPilotSummary(report([]), orangehrmProfile());
    expect(summary.pages.discovered).toBe(3);
    expect(summary.pages.visited).toBe(3);
    expect(summary.heuristicCoverage.applicable).toBe(8);
    expect(summary.heuristicCoverage.executed).toBe(6);
  });

  it("never calls heuristic-candidate counts business-workflow coverage (Phase 4 continuation correction)", () => {
    const summary = buildPilotSummary(report([]), orangehrmProfile());
    expect(summary.coverageNote.toLowerCase()).toContain("never a claim of business-workflow coverage");
  });

  it("never references ground truth (source-level check, redundant with tests/security/no-ground-truth-leak.test.ts)", () => {
    const content = readFileSync(resolve("src/reporting/pilot-report.ts"), "utf-8");
    expect(content.toLowerCase()).not.toContain("ground-truth");
    expect(content).not.toContain("groundTruth");
  });

  it("2026-09-15 fix: declaredWorkflows is honestly {manifestPresent:false} when no manifest is supplied, never fabricated", () => {
    const summary = buildPilotSummary(report([]), orangehrmProfile());
    expect(summary.declaredWorkflows).toEqual({ manifestPresent: false });
  });

  it("2026-09-15 fix: a supplied declaredWorkflows summary passes through unchanged, kept separate from heuristicCoverage", () => {
    const summary = buildPilotSummary(report([]), orangehrmProfile(), {
      manifestPresent: true,
      declared: 6,
      attempted: 4,
      completed: 2,
      blocked: 1,
      unsupported: 0,
    });
    expect(summary.declaredWorkflows).toEqual({
      manifestPresent: true,
      declared: 6,
      attempted: 4,
      completed: 2,
      blocked: 1,
      unsupported: 0,
    });
    // Still a real, distinct field -- never conflated with heuristicCoverage.
    expect(summary.heuristicCoverage.applicable).toBe(8);
  });
});

describe("summarizeDeclaredWorkflows (2026-09-15 fix)", () => {
  function manifest(workflowIds: string[]): WorkflowManifest {
    return {
      schemaVersion: 1,
      profileId: "orangehrm-test",
      pages: ["/dashboard", "/pim"],
      workflows: workflowIds.map((id) => ({
        id,
        page: "/pim",
        description: "d",
        preconditions: "p",
        authorizedActions: "a",
        expectedOutcome: "e",
      })),
    };
  }

  it("is honestly {manifestPresent:false} when no manifest exists for the profile", () => {
    expect(summarizeDeclaredWorkflows(undefined, { schemaVersion: 1, entries: [] })).toEqual({ manifestPresent: false });
  });

  it("counts each declared workflow's recorded status, without fabricating a status for one never recorded", () => {
    const m = manifest(["w1", "w2", "w3", "w4"]);
    const statusFile: WorkflowStatusFile = {
      schemaVersion: 1,
      entries: [
        { workflowId: "w1", status: "completed", evidenceRefs: [], humanReviewStatus: "not-reviewed", recordedAt: "t" },
        { workflowId: "w2", status: "blocked", evidenceRefs: [], humanReviewStatus: "not-reviewed", recordedAt: "t" },
        { workflowId: "w3", status: "attempted", evidenceRefs: [], humanReviewStatus: "not-reviewed", recordedAt: "t" },
        // w4 never recorded -- must not be counted as any status.
      ],
    };

    const result = summarizeDeclaredWorkflows(m, statusFile);

    expect(result).toEqual({ manifestPresent: true, declared: 4, attempted: 1, completed: 1, blocked: 1, unsupported: 0, failed: 0 });
  });
});
