# Phase 14 release evidence (2026-10-07)

**Status**

| Area | Status |
|---|---|
| Persistence (gate A) | verified |
| Reporting (gate B) | verified |
| Export (gate C) | verified |
| Engineering verification (gate D) | verified |
| Ajeer acceptance (gate E) | **pending** |

## Verified source
- Base commit `8de336c`, plus the Phase 14 working-tree changes (35 paths, listed by name in the verification summary).
- The source was unchanged during the run.
- The release commit contains exactly those changes, plus the documentation listed under "After verification".

## Verification `VER-20261007-082759793Z-0896`
Toolchain: Node v24.19.0, npm 11.17.0, TypeScript 5.9.3, vitest 4.1.11, Playwright 1.62.1, Chromium 151.0.7922.34.

| Stage | State |
|---|---|
| typecheck | passed (8 s) |
| build | passed (10 s) |
| test (`--maxWorkers=2`) | passed: 116 files, 847 tests, 0 failed (614 s) |
| challenge-corpus | passed (13 s) |

**Earlier record, kept locally:** `VER-20261007-081729342Z-7335`.
- **Stage result:** the test stage **failed** (exit 1) even though all 846 tests passed. Vitest reported one unhandled rejection: `request.response: Target page, context or browser has been closed` at `src/browser/observation.ts:53`. The recorder had no rejection handler when Stop closed the page during a request.
- **Fix:** the request is now recorded without a status.
- **Regression test:** `tests/browser/observation-recorders.test.ts`, which fails before the fix and passes after.

## Canonical benchmark (separate run)
`npm run qa -- --config qa.config.mock.yaml` → `RUN-20261007-083911956Z-58a2`. It ran under the diagnostic policy (local fixture), with 74 actions and 38 decisions.

| Metric | Precision | Recall | F1 |
|---|---|---|---|
| Raw (6 TP, 3 FP, 0 FN) | 0.667 | 1.000 | 0.800 |
| Final report | 0.75 | 1.00 | 0.86 |
| Grouped | 1.0 | 1.0 | 1.0 |

All three are unchanged.

## Synthetic acceptance
**Tests:**
- `tests/privacy/evidence-privacy.test.ts` (7):
  - canary sweep over artifacts, logs, events, temporary output, preview and exports;
  - a seeded defect fails with minimized evidence;
  - the correction passes;
  - the comparison is newly-failing by stable identity;
  - requirement coverage;
  - Stop with no late writes;
  - a forced minimizer failure gives a marker and incomplete evidence;
  - diagnostic opt-in;
  - legacy runs;
  - export containment (traversal, junction, unknown and binary files);
  - Markdown escaping.
- `tests/server/inert-rendering-ui.test.ts`: markup payloads in every finding field are rendered as text in results and the export preview; nothing executes and nothing remote loads.
- `tests/server/host-check.test.ts`: a foreign `Host` on GET returned 200 before the fix (reproduced) and returns 403 after it.

**UI demo** (`node dist/tests/demo/phase14-demo.js`, real control panel, canary fixture, owned-sandbox profile):

| Scenario | Run | Result |
|---|---|---|
| Passing workflow (private-looking labels) | `RUN-20261007-081518612Z-69e0` | PASS; baseline approved in the UI |
| Seeded defect | `RUN-20261007-081526467Z-e684` | FAIL; `REQ-STATEMENTS#C1: passed → failed` |
| Corrected | `RUN-20261007-081544319Z-bcb9` | PASS; export previewed, created and downloaded |
| Stop | `RUN-20261007-081552125Z-57ad` | stopped |
| Next run after Stop | `RUN-20261007-081558918Z-a628` | PASS |
| Diagnostic opt-in | `RUN-20261007-081608236Z-38e5` | PASS; export lists `screenshot.png` as excluded (`binary-unsupported`) |
| Legacy run | `RUN-20261006-104416718Z-b5cc` (Phase 13.1 synthetic) | labelled `legacy`; files unchanged |

- **Canary sweep:** no canary in any minimal run, its exports, or the downloaded export.
- **Visual check:** the export preview panel was screenshotted and inspected.

## Ajeer
- **Attempt on 2026-10-07:** `RUN-20261007-040204103Z-22b2` ended `AUTH_FAILED (stayed-on-login)`, not retried. No workflow ran.
- **Unchanged:** no new Ajeer evidence; scope, budgets and the Account exclusion are unchanged.
- **Older runs:** Ajeer runs before this release are legacy and unchanged.

## Known limitations
- Minimization is policy-based and was tested with canaries; it is not anonymization.
- Approved configuration text stays local.
- The live-model input boundary is unchanged.
- Run-log messages are kept as code literals.

## After verification (documentation only)
`PROGRESS.md`, `docs/release/PHASE14_EVIDENCE.md`.
