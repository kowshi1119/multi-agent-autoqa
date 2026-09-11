import type { AppConfig } from "../config.js";
import type { ProjectProfile } from "./schema.js";

/**
 * Projects a ProjectProfile (the ordinary-user-facing, non-secret layer)
 * into the existing AppConfig shape every downstream module already
 * consumes -- runPipeline(), the Orchestrator, the Planner/heuristics,
 * the Validator, and every oracle keep working entirely unchanged.
 * `target.environment` is set to the profile's environmentKind string
 * verbatim, so the codebase's existing `=== "local-fixture"` checks
 * (run-pipeline.ts, index.ts, H10's gate, ground-truth loading) require no
 * changes to keep working for a fixture profile.
 *
 * Fields a profile doesn't expose (oracle rules, requirements, per-
 * heuristic tuning) get conservative, safe defaults rather than requiring
 * an ordinary user to specify them -- the plan's "Advanced" section in the
 * eventual UI is where a power user overrides these by pointing at a full
 * qa.config.yaml instead of a profile.
 */
export function profileToAppConfig(profile: ProjectProfile): AppConfig {
  const isFixture = profile.target.environmentKind === "local-fixture";

  return {
    project: { name: profile.name },
    target: { url: profile.target.url, environment: profile.target.environmentKind },
    browser: {
      engine: "chromium",
      headless: true,
      viewport: { width: 1440, height: 900 },
    },
    agent: {
      maxActions: profile.limits.maxActions,
      maxModelCalls: profile.limits.maxModelCalls,
      maxPages: profile.limits.maxPages,
      maxFindings: profile.limits.maxFindings,
      maxDurationMs: profile.limits.maxDurationMs,
      maxCriticCalls: profile.limits.maxCriticCalls,
    },
    heuristics: {
      longTextBoundaryChars: 500,
      safeControlClick: { enabled: true, allowedControls: [] },
    },
    validation: { attempts: 3, minimumSuccesses: 2 },
    oracles: {
      uiApiConsistency: { enabled: true, rules: [] },
      console: { enabled: true, ignorePatterns: [] },
      pageError: { enabled: true },
      httpFailure: { enabled: true },
      duplicateRequest: { enabled: true, patterns: [] },
    },
    evidence: {
      screenshots: true,
      // Authenticated real-target profiles default trace capture off --
      // native traces can still carry cookies/session headers after login
      // even though JSON evidence is redacted (see src/auth's secret-
      // hygiene notes). A profile can only turn this back on once its own
      // trace-sanitization has been explicitly verified, not by default.
      trace: isFixture,
      console: true,
      network: true,
    },
    models: profile.provider,
    requirements: isFixture ? { enabled: true, path: "fixture/requirements.json" } : { enabled: false, path: "requirements.yaml" },
    grouping: { enabled: true },
    safety: {
      safeMode: true,
      allowedOrigins: profile.navigation.allowedOrigins,
    },
  };
}
