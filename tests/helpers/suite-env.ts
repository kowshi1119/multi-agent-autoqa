import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "../../src/profiles/store.js";
import { RunManager, type StartRunInput } from "../../src/run-manager.js";
import { targetIdentity } from "../../src/profiles/fingerprint.js";
import { readSuiteResult, type SuiteResult } from "../../src/suites/result.js";
import type { SuiteComparison } from "../../src/suites/compare.js";
import { readFileSync, existsSync } from "node:fs";

export const credentials = { username: "demo-a", password: "demo-a-synthetic-password" };

/** A synthetic sign-in profile plus one saved workflow and declared checks, all pointing at a local fixture. */
export function suiteEnvironment(origin: string, overrides: { limits?: Record<string, number>; apiChecks?: unknown[]; securityChecks?: unknown[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "autoqa-suite-"));
  const profilesDir = join(root, "profiles"); mkdirSync(profilesDir);
  const runsDir = join(root, "runs");
  const writeProfile = (patch: Record<string, unknown> = {}) => writeFileSync(join(profilesDir, "demo.json"), JSON.stringify({
    schemaVersion: 1, id: "demo", name: "Synthetic statements", target: { url: `${origin}/home`, environmentKind: "owned-sandbox" },
    navigation: { allowedOrigins: [origin], allowedPathPrefixes: ["/"] }, resources: { allowedApiOrigins: [origin], allowedFormSubmitEndpoints: [] },
    workflows: { allowedWorkflowKinds: ["navigate"], executionMode: "declared" },
    auth: { mode: "form-login", checksVerified: true, loginUrl: `${origin}/login`, usernameField: { label: "Username" }, passwordField: { label: "Password" }, submitControl: { role: "button", name: "Sign in" }, successUrlPattern: `^${origin.replace(/[.]/g, "\\.")}/home(?:[?#].*)?$`, authenticatedSignal: { role: "heading", name: "Demo Home" }, allowedRequests: [{ origin, method: "POST", pathname: "/session" }] },
    provider: { explorer: { provider: "mock" }, critic: { enabled: true, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 }, providerTimeoutMs: 30000 },
    limits: { maxActions: 25, maxModelCalls: 20, maxPages: 6, maxFindings: 8, maxDurationMs: 90000, maxCriticCalls: 5, maxApiRequests: 10, ...(overrides.limits ?? {}) },
    apiChecks: { enabled: true, allowedMutatingEndpoints: [], responseSizeCapBytes: 65536, useRunSession: true },
    securityChecks: { enabled: true },
    ...patch,
  }));
  writeProfile();
  writeFileSync(join(profilesDir, "demo.workflows.json"), JSON.stringify({ schemaVersion: 1, profileId: "demo", pages: ["/home"], workflows: [{
    id: "OPEN-STATEMENTS", page: "/home", kind: "navigate", description: "Open Statements from Home", preconditions: "Signed in on /home", authorizedActions: "Click the Statements link only", expectedOutcome: "Statements heading visible on /statements",
    execution: { steps: [{ pathname: "/home", resultingPathname: "/statements", action: { type: "click", target: { role: "link", name: "Statements" } } }], completion: { urlPattern: "/statements$", visible: { role: "heading", name: "Statements" } } },
  }] }));
  const writeChecks = (apiChecks = overrides.apiChecks, securityChecks = overrides.securityChecks) => writeFileSync(join(profilesDir, "demo.checks.json"), JSON.stringify({ schemaVersion: 1, profileId: "demo",
    apiChecks: apiChecks ?? [
      { id: "ME", method: "GET", pathname: "/api/me", description: "Signed-in member can read their profile", assertions: { expectedStatus: 200, requiredFields: ["id", "email"] } },
      { id: "TRANSFER", method: "POST", pathname: "/api/transfer", description: "Never sent: mutation not authorized", assertions: { expectedStatus: 200 } },
    ],
    securityChecks: securityChecks ?? [{ id: "HEADERS", kind: "security-headers", pathname: "/api/me", description: "Authenticated responses carry standard security headers" }],
  }));
  writeChecks();
  const store = new ProfileStore(profilesDir);
  const manager = new RunManager(store, runsDir);
  return { root, profilesDir, runsDir, store, manager, writeProfile, writeChecks };
}

export async function runSuite(env: ReturnType<typeof suiteEnvironment>, suiteId: string, input: Partial<StartRunInput> = {}, onStart?: (runId: string) => void) {
  const { runId } = await env.manager.startRun({ profileId: "demo", mode: "demo", credentials, suiteId, expected: targetIdentity(env.store, "demo"), ...input });
  onStart?.(runId);
  const deadline = Date.now() + 100_000;
  while (env.manager.getActiveRun() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const dir = join(env.runsDir, runId);
  const comparisonPath = join(dir, "suite-comparison.json");
  return {
    runId,
    dir,
    result: readSuiteResult(dir) as SuiteResult,
    comparison: existsSync(comparisonPath) ? JSON.parse(readFileSync(comparisonPath, "utf-8")) as SuiteComparison : undefined,
  };
}
