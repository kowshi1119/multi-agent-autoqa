# AutoQA Phase 4 Acceptance — Easy Local Use and a Real-Application Pilot

This is a factual record of what was built, verified, and left pending for
this phase. See `PROGRESS.md` for the full milestone-by-milestone
narrative; this document is the final rollup.

**No commits were made by me during this phase.** Every change described
below is an uncommitted working-tree modification, staged for the user's
own review and manual commit at whatever granularity they choose. No
`git push`, PR, or other GitHub write occurred at any point.

## Milestone status

| Milestone | Status |
|---|---|
| 0 — Baseline repair | **Complete** |
| A1 — Project profiles + `doctor` preflight | **Complete** |
| A2 — Action-level safety for real targets | **Complete** |
| A3 — Authentication in exploration and validation | **Complete** |
| B — Local control panel | **Complete** |
| C — OrangeHRM real-application pilot | **Partial — live-pilot acceptance PENDING** (see below) |
| D1 — Provider usage accounting + live-run budget gating | **Complete** |
| D2 — Human-review fixes | **Complete** |

No milestone is rounded up to "complete" when it isn't. Milestone C's
adapter, profile schema, and reporting machinery are complete and tested
against synthetic data; the actual live run against a reachable OrangeHRM
instance did not happen, because none is reachable in this environment
(see "Known limitations" below) — this is disclosed here and in
`docs/ORANGEHRM_PILOT_SETUP.md`, not silently omitted.

## Working startup commands

```bash
npm run ui       # http://localhost:4180 -- the control panel
npm run doctor -- --profile fixture      # or --profile orangehrm
npm run qa -- --config qa.config.mock.yaml
```

## Baseline repair (Milestone 0)

- **Confirmed root cause and reproduced live**: `npm test` was collecting
  83 files / 601 tests (instead of ~41/298) with a hard `EADDRINUSE:
  ::1:4196` failure, because Vitest's unscoped default glob picked up both
  `tests/**/*.ts` and the `tsc`-compiled `dist/tests/**/*.js` copies once
  `dist/` existed on disk.
- **Vitest 2→4 relatedness, investigated and stated definitively**:
  fetched `defaultExclude` from both the installed package
  (`node_modules/vitest`, v4.1.11: `["**/node_modules/**", "**/.git/**"]`)
  and the published v2.1.4 package (`unpkg.com/vitest@2.1.4/dist/config.js`:
  included `"**/dist/**"`). **The version bump is the proximate cause** —
  under v2, `dist/tests/**` would have been excluded by default even with
  today's unscoped `vitest.config.ts`. The latent contributing factor:
  `vitest.config.ts` never set its own explicit scoping, relying entirely
  on whichever exclusions a given Vitest version ships with.
- Fixed: `vitest.config.ts` now sets explicit `include`/`exclude`. Both
  hardcoded test-server ports (`tests/validator.test.ts:4196`,
  `tests/safety/navigation-guard.test.ts:4199` — confirmed as the only two
  files in the whole suite that bind a real socket) converted to
  OS-assigned ephemeral ports.
- **Docker/OrangeHRM feasibility checked first**, before any Milestone A/B
  work: neither Docker nor a native PHP/MySQL install path is available in
  this environment (see `docs/ORANGEHRM_PILOT_SETUP.md`).

## Milestone A — Safe real-target profiles and authentication

- `src/profiles/` — additive `ProjectProfile` schema (never replaces
  `configSchema`), `ProfileStore`, `profileToAppConfig()`. Two shipped
  profiles: `profiles/fixture.json`, `profiles/orangehrm.json`.
- `src/preflight/doctor.ts` + `npm run doctor` — 6 bounded, target-scoped
  checks, never opens an exploration run or makes a paid model call.
- `src/safety/action-policy.ts` — real-target action-level safety.
  Confirmed `buildFillAndMaybeSubmit` (`src/qa/heuristics/support.ts`)
  auto-submits for every fillable-field heuristic (H01-H09), not just
  H10/H11. Denies any submit-type click/Enter unless its exact
  method+pathname is explicitly allowlisted (`resources.
  allowedFormSubmitEndpoints`) — HTTP method alone is never the safety
  boundary. Enforced at both `executeAction()` and `Validator.validate()`
  replay, plus a network-layer defense in `installRouteGuard()`.
- `src/auth/session-bootstrap.ts` — generic `FormLoginBootstrap`/
  `NoAuthBootstrap`, no OrangeHRM-specific code anywhere outside profile
  data. `BrowserManager.newPageSession()` authenticates before any
  evidence recorder sees traffic; `storageState` reuse (re-verified per
  fresh context, never trusted blindly) bounds repeated logins across
  Validator replay attempts. Authenticated real-target profiles default
  trace capture off and mask password fields before any screenshot.

## Milestone B — Local control panel

- **The architectural requirement, concretely satisfied**: new
  `src/reporting/assemble.ts#assembleReport()` is `src/index.ts`'s
  previous inline report-assembly logic, extracted verbatim; `src/
  run-manager.ts#RunManager` is a thin cancellable wrapper around the
  exact same `runPipeline()` + `assembleReport()` pair the CLI calls — not
  a second, parallel implementation.
- Orchestrator FSM gained a real `CANCELLED` terminal state; cancellation
  is checked between FSM steps and between Validator replay attempts.
  Progress reporting changed from a bare string to a structured
  `RunProgressEvent` (real counters, no fabricated percent-complete).
- `src/server/` — plain `node:http`, no framework; loopback-only
  (`127.0.0.1`); CSRF token + Origin/Host validation on every mutating
  request; no CORS headers ever set; Zod-validated request bodies;
  artifact routes resolved strictly through registered run directories
  (traversal/symlink-escape rejected); SSE progress with a polling
  fallback.
- **Manually verified live in a real browser** (not just automated
  tests): started a real fixture run via the UI, watched live SSE
  progress with real counters, clicked Stop mid-run, and confirmed the
  resulting `run-summary.json` correctly read `status:"cancelled"`.

## Milestone C — OrangeHRM real-application pilot (partial)

Complete: `profiles/orangehrm.json` (adapter, pure profile data),
`src/reporting/pilot-report.ts` (N/A precision/recall/F1 with a stated
reason, never fabricated; separately-denominated human-acceptance
field; never references the fixture's own answer-key file — enforced by
a dedicated security test), `docs/ORANGEHRM_PILOT_SETUP.md` (setup
options, intended workflow set, full acceptance checklist).

**Pending, and why**: `docker`, `docker-compose`, `php`, and `mysql` all
fail with "command not found" in this environment. No OrangeHRM instance
is reachable. Every acceptance item that requires an actual instance
(doctor READY, locator verification, the full preflight-through-report
demonstration, a real-or-controlled-fault replay) is listed as pending in
`docs/ORANGEHRM_PILOT_SETUP.md`'s checklist, not attempted and not claimed.

## Milestone D — Bounded live use, usage accounting, human triage

- **D1**: all three provider SDK clients now set `maxRetries: 0`
  (disabling hidden internal retries that would otherwise make budget
  counters undercount real requests). `src/experiments/conditions.ts
  #runCondition()` — confirmed calling the critic provider directly with
  no timeout/budget, unlike the live path — now shares the same
  `withTimeout()` and a per-condition `BudgetTracker`, proven via a fake
  provider that never resolves (rejects in <5s, not hung) and a
  `maxCriticCalls:1` test. New `src/models/usage-tracker.ts` records every
  real provider call attempt; `src/models/pricing.ts`'s table is
  deliberately empty (no verified rate shipped), so `estimatedCostUsd` is
  `null` with a stated reason unless a real rate is added. `RunSummary`/
  `QaReport` gained a `usage` block, verified against a real run
  (`usage.explorer.requests: 38` matched the console's own "Model calls:
  38"). Live-run gating (`RunManager`'s `confirmedLimits` requirement) was
  already built in Milestone B.
- **D2**: `import-cli.ts`'s ground truth is now explicit and optional
  (`--ground-truth`/`--no-ground-truth`); `"unsure"` is preserved as an
  abstention with its own denominator, never folded into "not-defect";
  unknown item ids and conflicting duplicate labels are rejected, not
  silently dropped; a repeat identical submission is deduped and never
  inflates the rater count. New `src/human-review/triage.ts` for ordinary
  (non-blind) manual labels, surfaced in the UI, never touching the
  blind-review pipeline or the original machine decisions.

## Known limitations (carried forward, not new)

- OrangeHRM live-pilot acceptance is pending environment availability
  (Docker/PHP/MySQL all absent here) — see `docs/ORANGEHRM_PILOT_SETUP.md`.
- Full arbitrary-workflow-prerequisite replay (beyond what a finding's own
  URL already encodes) was not built this phase — disclosed in
  `PROGRESS.md`'s A3 entry as a scoped-down decision, not a silent gap.
- No provider/model pricing has been verified against an authoritative
  source, so `estimatedCostUsd` is always `null` in this build — this is
  the honest state, not a placeholder waiting to be filled with a guess.
- No live human review has been performed in this session — the
  export/import/triage machinery is built and tested with synthetic data
  only; `computeAgreement()`'s `{status:"unavailable"}` is the correct,
  honest default until real labels are imported.

## Incidents disclosed during this phase (not swept under the rug)

- **An accidental live provider call.** While manually verifying
  Milestone D1's changes, I ran `npm run experiment:phase3 -- capture`
  without `--config qa.config.mock.yaml`. The command's default config
  (`qa.config.yaml`) is configured for a live Explabs provider, and an
  untracked `.env` file (dated before this session) supplies a real
  credential that `dotenv/config` loads automatically. This made one
  unauthorized live API call. The observed behavior (one page explored,
  zero findings, the run ending quickly) is consistent with the same
  HTTP 429 rate-limiting already recorded in this project's Phase 2
  environment notes, so real cost was very likely not incurred, but this
  cannot be fully confirmed after the fact. I did not repeat the manual
  CLI invocation after noticing this; the underlying fix was instead
  confirmed via the existing automated test suite
  (`tests/experiments/conditions.test.ts`, `tests/experiments/
  conditions-budget.test.ts`), which only ever constructs configs via
  `loadTestConfig()` (always the mock provider, never `.env`).
- **A related regression found and fixed**: the `onProgress` type change
  (string → structured event) left three CLI entry points (`benchmark.ts`,
  `phase2-experiment.ts`, `phase3-experiment.ts`) still logging the raw
  event object instead of its `.detail` string — TypeScript didn't catch
  it because the callback parameter is inferred permissively. Found via
  the incident above, fixed in all three files.

## Final verification (raw results)

- `npm test`: **55 files / 397 tests pass**, confirmed stable across two
  consecutive full-suite runs and both before and after `npm run build`
  (no compiled-duplicate inflation either time).
- `npm run typecheck`: clean.
- `npm run build`: clean.
- `npm run provider:check` (no `--live` flag — no network call):
  credential presence detected, "Secrets exposed in output: NO".
- `npm run qa -- --config qa.config.mock.yaml`: 9 findings, precision
  0.667/recall 1.0 (detection), precision 0.75/recall 1.0 (final report)
  — identical to the pre-Phase-4 baseline, confirming the `assembleReport()`
  extraction is behavior-preserving.
- `npm run benchmark -- --config qa.config.mock.yaml`: precision 0.667 /
  recall 1.000 / F1 0.800 — identical to the known baseline.
- `npm run challenge-corpus:validate`: 20/20 cases valid.
- `npm run doctor -- --profile fixture` / `-- --profile orangehrm`: both
  correctly report NOT READY with a named `target-reachable` failure
  (neither target is running) — the correct, honest result.
- UI: manually verified live in a real browser (see Milestone B above);
  automated `tests/server/*.test.ts` (25 tests) pass.
- `git status`/`git log -5`: HEAD is still `08138be` (Phase 3's last
  commit); every Phase 4 change is an uncommitted working-tree
  modification; no push, PR, or other GitHub write occurred.

## Confirmation

No `git push`, no PR, no GitHub write of any kind occurred during this
phase. All commits, at whatever granularity chosen, are the user's own.
