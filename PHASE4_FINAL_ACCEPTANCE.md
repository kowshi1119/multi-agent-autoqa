# AutoQA Phase 4 — Final Acceptance (2026-09-16)

This is the closing record for Phase 4, written after a fourth corrective
pass. The 2026-09-15 pass's own handoff claimed a cancellation bound of
"≤15s login-step / ≤5s replay-exploration-step." An independent
real-Chromium probe disproved this: requesting Stop during a 10-second
`wait` action returned success ~9.9s later. This pass found the root
cause, fixed it genuinely (verified down to individual Playwright calls,
not just FSM-level checks), closed the remaining test-port collisions,
and walked the full ordinary-user journey live in a real browser —
finding and fixing one real usability gap in the process. The user also
explicitly **deferred the OrangeHRM real-application pilot** this pass;
it is marked "deferred by user" below, not attempted, not blocked by
environment (though it remains that too). See `docs/PHASE4_ACCEPTANCE.md`
for the full narrative and every prior pass's history; this file is the
compact, current-state acceptance record.

## Headline findings this pass

1. **The 2026-09-15 cancellation-bound claim was false.** Every
   `signal?.aborted` check in the codebase was a snapshot check at the
   top of a function/loop iteration — it only ever prevented the *next*
   unit of work from starting. Nothing was wired into an *already
   in-flight* Playwright call, so a `wait` action (or a slow navigation,
   reload, or locator wait) already running when Stop fired continued to
   its own full duration/timeout regardless. **Fixed**: every Playwright
   call that supports it (`Locator.click`/`.fill`/`.press`/`.waitFor`,
   `Page.goto`/`.reload`/`.waitForURL`) now receives `signal` directly, so
   Playwright itself aborts the in-flight operation; `page.
   waitForTimeout()` (no native `signal` hook) was replaced with a
   `Promise.race`-based helper. New measured bound: ~0.5–2 seconds
   regardless of the interrupted operation's own timeout — proven with
   wall-clock tests, not asserted.

2. **A pre-existing FAILED-vs-CANCELLED mislabeling bug**, found while
   wiring the fix above: a login cancelled via `ensureAuthenticated()`'s
   retry loop threw `AuthenticationError{reason:"cancelled"}`, which
   `Orchestrator.initialize()`'s catch block mapped to FSM state
   `FAILED`. A cancelled run's report must say "stopped," never "failed"
   (per the FSM's own doc comment). **Fixed.**

3. **A real usability gap found only by the live-browser walkthrough**:
   the "Prior runs" list rendered unbounded, with no scroll container —
   60+ accumulated runs pushed the actual run controls off-screen.
   **Fixed**: a bounded, scrollable container; every run stays reachable.

## Acceptance checklist (final status, 2026-09-16)

| # | Area | Status | Evidence |
|---|---|---|---|
| 1 | Cancellation — genuine mid-operation interruption (wait, navigate, reload, locator actions, login, replay) | **Verified** | `tests/actions-cancellation.test.ts` (new, 5 tests), strengthened tests in `tests/auth/session-bootstrap.test.ts`, `tests/validator.test.ts` — all wall-clock-measured against a stalling real server, not asserted |
| 2 | Cancellation prevents subsequent actions/provider requests | **Verified** | Same tests; `tests/run-manager.test.ts`'s cancellation test confirms a stopped run never resumes |
| 3 | Partial results/usage preserved after cancellation | **Verified** | `tests/run-manager.test.ts` strengthened to assert non-zero `actionsPerformed`/`budget`; live-confirmed in browser (5 validated findings retained on a cancelled run) |
| 4 | Test-owned port isolation (six previously-hardcoded ports) | **Verified** | `src/run-pipeline.ts` always binds local-fixture to an OS-assigned port; `tests/run-pipeline-port-isolation.test.ts` (new) proves two concurrent runs on the same declared placeholder port land on distinct real ports; full suite + `npm run qa` both confirmed unaffected |
| 5 | Ordinary-user journey (create/edit profile, explicit scope, provider identity, Check setup, mock run, progress/refresh/Stop, results/evidence/screenshots/history) | **Verified, live in a real browser** | See walkthrough below; against both `fixture` and a real `owned-sandbox` disposable-server profile |
| 6 | Real-target policy enforcement tested without `local-fixture` mislabeling | **Verified** | New cancellation tests and the UX walkthrough use `self-hosted-real-app`/`owned-sandbox` profiles against disposable local servers, never `local-fixture`, for anything meant to exercise `ActionPolicy` |
| 7 | Architecture/scope preserved (model reasons, code decides; deterministic oracles; independent reproduction; secret redaction; budget enforcement; live-provider gating) | **Verified, unchanged** | No changes this pass touch these; full suite still passes |
| 8 | Real-app (OrangeHRM) pilot | **Deferred by user** | Explicit instruction this pass: defer entirely, do not investigate or install. All pilot files preserved untouched from 2026-09-15 |

Everything verified in the 2026-09-15 record (redaction boundaries,
budget accounting, redirect safety, profile create/edit CRUD, declared-
workflow manifest machinery, etc.) is unchanged and still holds — this
pass did not touch that code.

## Exact commands run and real results (this pass, 2026-09-16)

```
npm run typecheck
```
Clean. No errors.

```
npm run build
```
Clean. No errors.

```
npx vitest run
```
**66 test files / 550 tests pass.** (Up from 64/542 at the 2026-09-15
pass's own count — this pass added `tests/actions-cancellation.test.ts`
(5 tests) and `tests/run-pipeline-port-isolation.test.ts` (1 test), plus
new/strengthened tests in three existing files.) Run in isolation.

```
npm run qa -- --config qa.config.mock.yaml
```
9 findings suspected, 9 validated, 0 rejected, 0 needs-human.
Detection: precision 0.67 / recall 1.00 / F1 0.80.
Final report: precision 0.75 / recall 1.00 / F1 0.86.
**Identical to every prior baseline.** `Target: http://localhost:53823/`
— the config file's own literal `4173` was dynamically overridden to a
real OS-assigned port, confirming the port-isolation fix works on the
actual production CLI path, not only in tests.

```
npm run doctor -- --profile fixture
```
```
✓ Profile schema
✓ Chromium launchable
✓ Navigation scope consistency
~ Target reachable (managed — local fixture starts automatically)
- Login configuration (auth.mode "none")
✓ Provider configuration
Overall: READY
```

`npm run doctor -- --profile orangehrm` was **deliberately not run** this
pass — the pilot is deferred by explicit user instruction; re-running it
would add nothing new to this record and risks reading as renewed pilot
investigation.

## Real-browser UI verification (Claude Browser MCP, http://localhost:4180)

Performed live against two targets — the bundled `fixture` profile, and
a newly-created **`owned-sandbox`** profile pointed at a disposable local
Node HTTP server (deliberately not `local-fixture`, which never
constructs an `ActionPolicy` — using it here would have silently skipped
scope-enforcement verification):

1. Rebuilt and restarted the UI server with this pass's changes.
2. **Create profile**: clicked "New profile," filled id/name/target URL
   (`http://localhost:8931/`), set environment kind to `owned-sandbox`,
   and supplied a full JSON body declaring explicit scope
   (`navigation.allowedOrigins`/`allowedPathPrefixes`,
   `resources.allowedApiOrigins`/`allowedFormSubmitEndpoints`). Saved
   successfully; the new profile appeared in the dropdown with correct
   provider identity ("explorer: mock, critic: mock") shown before
   starting anything.
3. **Check setup**: all six checks passed, including a **genuine**
   reachability probe (`Target reachable: http://localhost:8931/
   responded with HTTP 200` — actively probed, unlike the fixture's
   managed `~`). `Overall: READY`.
4. **Start (mock run) against the real disposable server**: completed in
   under a second — 2 pages discovered/visited, 1 action performed, 0
   findings (an honest, non-alarming result for a near-empty demo page,
   not a bug).
5. **Refresh mid-run**: switched to the `fixture` profile (longer-running)
   and started a run; refreshed the page ~2s in — the page correctly
   recovered the active run, live counters, and Stop access without any
   manual reconnection step.
6. **Stop**: clicked Stop; the run reached `status: "cancelled"` within
   ~2 seconds (button click to confirmed-stopped). Verified via a direct
   `GET /api/runs` fetch: **5 validated findings and a full budget/usage
   snapshot were retained** — `actionsPerformed: 53`, not zeroed; nothing
   silently discarded by cancellation.
7. **Results**: 4 reportable finding cards (one pair grouped), each
   showing reproduction count (3/3), evidence level, critic verdict, an
   **inline screenshot**, and links to every other evidence file
   (console/network/page-errors/trace). Confirmed one screenshot resolves
   via a direct HTTP request: `200 image/png 12710 bytes`.
8. **A real usability gap found here, not by any prior pass**: the
   "Prior runs" list (60+ entries in this dev environment) rendered with
   no scroll container, pushing the run controls far down the page.
   **Fixed live**: `#prior-runs` gained `max-height: 320px; overflow-y:
   auto` in `src/server/public/index.html`. Re-verified:
   `clientHeight: 305` vs `scrollHeight: 6459` — bounded, everything
   still reachable.
9. Cleaned up: deleted the verification-only `demo-app-sandbox` profile
   and stopped its disposable server — `profiles/fixture.json`,
   `profiles/orangehrm.json`, and `profiles/orangehrm.workflows.json` are
   the only profile files remaining.

## Concrete cancellation bound (corrected this pass — the prior number was false)

**Stop now interrupts whatever operation is currently in flight —
typically within ~0.5–2 seconds — regardless of that operation's own
configured timeout or duration.** This supersedes the 2026-09-15 record's
"≤15s login-step / ≤5s replay-exploration-step" claim, which described
only when the *next* step could start, not genuine interruption of one
already running; a real-Chromium probe found that claim false (a 10s
`wait` action returned ~9.9s after Stop, not within the claimed 5s).

Mechanism: every Playwright call `executeAction()`, `FormLoginBootstrap.
establish()`, and `BrowserManager.ensureAuthenticated()` make that
natively supports a `signal` option (`Locator.click`/`.fill`/`.press`/
`.waitFor`, `Page.goto`/`.reload`/`.waitForURL` — confirmed against the
installed Playwright version's own type definitions) now receives the
run's `AbortSignal` directly, so Playwright itself aborts the in-flight
operation. `page.waitForTimeout()` (no native `signal` hook) was replaced
with a `Promise.race`-based `abortableDelay()` helper. This mirrors the
codebase's own pre-existing, working pattern for genuine interruption
(`deriveTimeoutSignal()`/`withTimeout()` in `critic-runner.ts`, already
used for provider SDK calls) rather than inventing a new mechanism.

**Proven, not asserted**: `tests/actions-cancellation.test.ts` (new)
wall-clock-measures a 10-second `wait`, a navigation and reload against a
server that never responds, and a click waiting on an element that never
appears — every case returns in under 2–3 seconds with a
`CANCELLED`-labeled reason; the entire 5-test file runs in ~4.4 seconds
total, direct proof no test ever fell through to a real timeout.
Equivalent new tests were added for login (`tests/auth/
session-bootstrap.test.ts`, stalling the login page's own HTTP response)
and replay (`tests/validator.test.ts`, targeting a trigger step whose
element never appears).

## Real-application pilot status — deferred by user

**As of this pass, deferred by explicit user instruction**, not (only)
blocked by environment: "I am explicitly deferring OrangeHRM and its
real-application pilot. Do not install OrangeHRM, investigate its
dependencies, or let it block further work. Preserve the existing pilot
files for later and mark this acceptance item 'deferred by user,' not
completed." No OrangeHRM-related investigation, dependency check, or
installation attempt occurred in this pass. `profiles/orangehrm.json`,
`profiles/orangehrm.workflows.json`, and `docs/ORANGEHRM_PILOT_SETUP.md`
are preserved exactly as the 2026-09-15 pass left them (confirmed via
`git diff` showing no changes from this pass) for whenever this work
resumes. See `docs/PHASE4_ACCEPTANCE.md`'s Milestone C section and
`docs/ORANGEHRM_PILOT_SETUP.md` for the full, still-accurate 2026-09-15
state (environment blocker, prepared-but-unrun declared-workflow
manifest, disclosed locator placeholders).

## Confirmation

- This working tree is a real git repository. HEAD is unchanged at
  `17b6aa9` ("Update AutoQA project") on branch
  `chore/vitest-security-upgrade`. Every file this pass touched shows as
  `modified` or untracked; **nothing was staged, committed, or pushed**.
- No live or paid provider request was made anywhere in this pass —
  `provider: mock` throughout; a disposable local HTTP server with no
  real data stood in for a "real" target during verification.
- No `.env`, private credential, seeded ground-truth file, or historical
  run artifact was modified.
- No new provider, agent, or feature outside this milestone's authorized
  scope was added.
- `profiles/orangehrm.json`, `profiles/orangehrm.workflows.json`, and
  `docs/ORANGEHRM_PILOT_SETUP.md` were not touched this pass (confirmed
  via `git diff`) — the diffs they carry predate this session.
- One genuine bug (FAILED-vs-CANCELLED mislabeling on a cancelled login,
  see headline finding #2) and one genuine usability gap (the unbounded
  prior-runs list, headline finding #3) were found and fixed beyond this
  pass's own anticipated scope — both disclosed above with root cause,
  fix, and verification, not silently patched.

## How to use the local interface

```bash
npm run ui       # http://localhost:4180
```

- Choose the `fixture` profile for a safe deterministic demo, or click
  **New profile** to point AutoQA at your own target — quick fields for
  id/name/target-URL/environment-kind, a full JSON textarea for
  everything else (declare `navigation.allowedOrigins`/
  `allowedPathPrefixes` and `resources.allowedApiOrigins`/
  `allowedFormSubmitEndpoints` explicitly — anything outside that scope
  is denied by default). A rejected save shows the real schema error
  inline.
- Click **Check setup** — a genuine ✗ names the exact failing check and
  refuses Start server-side, not just in the UI.
- Choose **Demo** (mock providers, no live calls) and click **Start**.
  Refreshing mid-run reconnects without losing progress or Stop access.
- **Stop** genuinely interrupts whatever is happening right now — typically
  within ~0.5–2 seconds — and the run keeps everything it found and did
  before Stop; it's labeled "stopped," never "completed" or "failed."
- **Results**: grouped finding cards with reproduction counts, an inline
  screenshot, and links to every other evidence file. Prior runs are
  listed below in a scrollable panel.

## Remaining limitations / required user input

- **OrangeHRM real-application pilot is deferred by user request.**
  Everything independently prepared before the deferral (the profile's
  own login-policy fix, the declared-workflow manifest) remains ready for
  whenever this resumes; the environment blocker (Docker/PHP/MySQL
  absent) was last confirmed 2026-09-15 and was not re-checked this pass
  per instruction.
- No live human review has been performed; the export/import/triage
  machinery is tested only with synthetic data.
- `estimatedCostUsd` remains `null` — no provider/model pricing table has
  been verified against an authoritative source.
- The cancellation bound (~0.5–2s) is an empirically measured range from
  this pass's own tests, not a formally guaranteed hard ceiling — actual
  latency depends on Playwright's own abort-handling speed for whichever
  operation was in flight.
