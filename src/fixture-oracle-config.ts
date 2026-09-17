import type { AppConfig } from "./config.js";

/**
 * The exact oracle configuration `qa.config.mock.yaml` declares for the
 * local fixture -- extracted here so profileToAppConfig() (the UI/profile
 * path a Demo/managed fixture run takes) can reference the SAME
 * rules/patterns instead of silently defaulting to empty ones (a
 * confirmed Phase 4 continuation gap: a UI-driven fixture run and a CLI
 * `--config qa.config.mock.yaml` run of the identical fixture app
 * previously exercised DIFFERENT oracle configuration and could report
 * different findings for the same defects).
 *
 * `tests/fixture-oracle-config-parity.test.ts` asserts qa.config.mock.yaml's
 * own parsed oracle section deep-equals this constant, so the two can
 * never drift apart unnoticed -- a YAML file can't literally import a TS
 * constant, so keeping them in sync is enforced by that test, not by a
 * single shared source. Update both together if the fixture's oracle
 * rules ever change.
 */
export const FIXTURE_ORACLE_CONFIG: AppConfig["oracles"] = {
  uiApiConsistency: {
    enabled: true,
    rules: [
      {
        id: "payment-consistency",
        request: { method: "POST", pathname: "/api/payment-consistency" },
        failureStatusMin: 500,
        forbiddenVisibleText: "Payment successful",
      },
    ],
  },
  console: { enabled: true, ignorePatterns: ["Failed to load resource:"] },
  pageError: { enabled: true },
  httpFailure: { enabled: true },
  duplicateRequest: {
    enabled: true,
    patterns: [{ method: "POST", pathname: "/api/submit", expectedMax: 1 }],
  },
};
