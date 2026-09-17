# AutoQA Phase 4 Acceptance — Easy Local Use and a Real-Application Pilot

This is a factual record of what was built, verified, and left pending —
covering the original Phase 4 pass, the **2026-09-11 continuation**
(prompted by an independent review that found concrete, confirmed gaps in
action-policy enforcement, secret redaction, request accounting,
cancellation, and UI acceptance), and the **2026-09-14 addendum** (a
follow-up review that found two of that continuation's own "Complete"
claims — navigation/redirect policy and preflight ordering — premature,
using real-Chromium empirical probes rather than trusting passing tests
alone, and named several other items as still open). This document
reflects the current, corrected state; see `PROGRESS.md` for the full
narrative and "What the 2026-09-14 addendum fixed" below for the latest
round.

**No commits, staging, or GitHub writes were made by the assistant during
any pass.** The user manually committed the original Phase 4 pass
themselves between sessions (`17b6aa9`, "Update AutoQA project") — exactly
the workflow authorized ("I will commit manually"). Every later pass's own
changes are, as of this document, still entirely uncommitted working-tree
modifications on top of that commit, for the user's own review and manual
commit at whatever granularity they choose. No `git push`, PR, or other
GitHub write occurred at any point in any pass. No live/paid provider
request was made in the 2026-09-14 addendum's own work — mock providers
and fake credentials throughout.

## Milestone status (post-addendum)

| Milestone | Status |
|---|---|
| 0 — Baseline repair | **Complete** |
| A1 — Project profiles + `doctor` preflight | **Complete** — preflight path-scope gap closed by the 2026-09-14 addendum (§6a) |
| A2 — Action-level safety for real targets | **Complete** — rewritten 2026-09-11; redirect-chain bypass closed by the 2026-09-14 addendum (§1a/§1b); §1c ("fill" scope) remains a disclosed judgment call, not a closed item |
| A3 — Authentication in exploration and validation | **Complete** — recorder-ordering/secret-hygiene fixed 2026-09-11; login cancellation added by the 2026-09-14 addendum (§8a), its own `orangehrm.json` policy-integration bug fixed by the 2026-09-15 pass, and cancellation itself made genuinely mid-operation (not just between-step) by the 2026-09-16 pass after a real-Chromium probe found the 2026-09-15 bound claim false |
| B — Local control panel | **Complete** — real gaps (evidence links, active-run recovery, terminal-progress event, preflight enforcement) fixed 2026-09-11; run-start race actually closed by the 2026-09-14 addendum (§5, see below — the 2026-09-11 claim was premature); profile create/edit UI added and browser-verified by the 2026-09-15 pass |
| C — OrangeHRM real-application pilot | **Partial — live-pilot acceptance PENDING** (rechecked 2026-09-15, still unreachable; see below). The 2026-09-15 pass fixed a pilot-blocking policy bug in `orangehrm.json` and authored a real declared-workflow manifest — both independent of the environment blocker |
| D1 — Provider usage accounting + live-run budget gating | **Complete** — undercounting and non-cancellation fixed 2026-09-11; per-request budget enforcement (not per-decision) added by the 2026-09-14 addendum (§4) |
| D2 — Human-review fixes | **Complete** |

No milestone is rounded up to "complete" when it isn't. Milestone C's
adapter, profile schema, and reporting machinery are complete and tested
against synthetic data; the actual live run against a reachable OrangeHRM
instance did not happen, because none is reachable in this environment
(rechecked at the start of this continuation — see "Known limitations"
below and `docs/ORANGEHRM_PILOT_SETUP.md`).

## Working startup commands

```bash
npm run ui       # http://localhost:4180 -- the control panel
npm run doctor -- --profile fixture      # or --profile orangehrm
npm run qa -- --config qa.config.mock.yaml
```

A `--live` flag is now required (see below) whenever the resolved explorer
or critic provider is not `mock` — this applies to `qa`, `benchmark`, and
`experiment:phase3` (capture and replay).

## What the 2026-09-11 continuation fixed

Organized by the review's own numbering, each mapped to the specific
confirmed gap and its fix.

### §1 — Real-target action-policy enforcement

**Confirmed gaps**: `allowedPathPrefixes`/`allowedApiOrigins`/
`allowedWorkflowKinds` were declared in a profile's schema but never
actually read by `ActionPolicy`; an unknown plain-button click outside
scope was allowed; an unknown `fill` action got zero policy check at all
(the `"fill"` branch in `executeAction()` never called the policy check);
`GET /delete-record`-shaped requests were allowed; a direct CLI run
(`npm run qa -- --config <real-target>.yaml`, bypassing `RunManager`, the
only place that previously constructed an `ActionPolicy` at all) got zero
enforcement; `classifyResourceRequest` checked pathname only, so a
cross-origin request to an allowlisted-looking path slipped through.

**Fix**: `src/safety/action-policy.ts` rewritten. New `pathWithinPrefix()`
helper closes the `/admin` vs `/administrator` boundary bug. A path-scope
gate now applies to every action (not just submits), including `fill`.
Non-submit clicks deny by default unless resolved as an in-scope
navigation link or a recognized pagination/sort control, each gated by
its own declared `allowedWorkflowKinds` entry. `classifyResourceRequest`
gained `origin`/`resourceType` parameters: asset requests are always
allowed, API requests require an allowlisted origin, GET requests
matching a destructive-keyword pattern are denied. New
`buildFallbackActionPolicy()` in `src/run-pipeline.ts` constructs a
conservative, deny-by-default policy for any direct CLI run against a
non-fixture target that didn't supply one explicitly.

### §2 — Authentication evidence boundaries and secret hygiene

**Confirmed gaps**: `BrowserManager.newPageSession()`'s doc comment
claimed recorders attach after authentication; the code actually attached
them before. A UI-submitted password (never touching `process.env`) was
entirely unredacted from evidence/logs — `redactSecrets()` only knew
`process.env["QA_PASSWORD"]`. `FormLoginBootstrap.establish()` silently
swallowed a `waitForURL` timeout and decided success from
signal-visibility alone, so a page that never navigated could still read
as a successful login if some unrelated element happened to match the
configured signal. A context whose login ultimately failed was never
explicitly closed.

**Fix**: recorder attachment moved to after a successful login (or
immediately for a no-auth session); guards stay active throughout login
either way. `redactSecrets()` gained an `extraSecrets` parameter;
`credentialSecrets()` derives it from a run's `TransientCredentials`
without ever touching `process.env`, threaded through the logger, every
evidence-writing call site, and both `Orchestrator`/`Validator`.
`FormLoginBootstrap` now explicitly checks the post-login URL against
`successUrlPattern` AND the signal's visibility — both must hold; a new
`"success-url-mismatch"` failure reason is added. `successUrlPattern` is
validated as a real regex at profile-parse time. A failed
`ensureAuthenticated()` call now explicitly closes its context before
rethrowing.

### §3 — Provider request accounting, real cancellation, live-execution gating

**Confirmed gaps**: `UsageTracker.recordAttempt()` wrapped the whole
logical `decideNextAction()`/`critique()` call, which can internally make
a first-attempt AND a repair-attempt HTTP request — undercounting by
construction. `withTimeout()`'s `Promise.race` never aborted the losing
promise, so a "timed out" call kept running in the background. No
`AbortSignal` was ever passed into an SDK call anywhere, so a
user-initiated Stop never actually interrupted an in-flight provider
request. No entry point besides `RunManager` (which has its own
`confirmedLimits`-based gate) required explicit authorization before
making a live provider call.

**Fix**: usage accounting moved into each real provider's own `complete()`
boundary (`AnthropicModelProvider`/`ExplabsModelProvider`/
`AnthropicCriticProvider`/`ExplabsCriticProvider`), so a first+repair
decision now correctly records 2 attempts, each with its own measured
token usage; `MockModelProvider`/`MockCriticProvider` never wrap in
`recordAttempt`, so a mock-only run shows `usage.explorer.requests: 0`.
New `deriveTimeoutSignal()` builds an `AbortSignal` from the same
deadline `withTimeout()` races against, combined with the run's own
`abortSignal` (a Stop) via `AbortSignal.any()`, and is now passed into
every real SDK call — a timeout or a Stop genuinely aborts the in-flight
HTTP request. The Orchestrator's own terminal-transition ordering bug
(below) was found and fixed in the same pass. New
`src/models/live-gate.ts#assertLiveModeAuthorized()` requires an explicit
`--live` CLI flag whenever the resolved explorer or critic provider isn't
`mock`; wired into `qa`, `benchmark`, `experiment:phase3` (capture and
replay), and standalone experiment replay. An API key already present in
`.env` is never, by itself, treated as authorization.

**Known remaining limitation, closed by the 2026-09-14 addendum**: budget
reservation (`BudgetTracker`) was still checked once per logical decision,
not once per individual real HTTP request when this section was written —
disclosed then, fixed now. See "What the 2026-09-14 addendum fixed" below.

### §4a — Validator inconclusive-outcome handling

**Confirmed gap**: `decideStatus()` only ever saw a `successes` count; a
finding whose every replay attempt was tooling-blocked (a policy denial,
an auth failure, a broken locator) produced `successes: 0`, identical to
a finding that genuinely replayed and never reproduced — both read as
`"rejected"`, silently and incorrectly claiming the finding was
disproven.

**Fix**: `decideStatus(successes, validAttempts, minimumSuccesses)` — when
`validAttempts === 0` (every attempt was tooling-blocked), the finding is
`"needs_human"`, never `"rejected"`. Blocked attempts are excluded from
both the numerator and the denominator when some attempts did genuinely
run.

### §4b — Bounded workflow-prerequisite replay

New, scoped: `Finding.prerequisitePrefix` — a short (capped at 8 steps),
deterministic tail of the same run's own already-executed step history,
populated only for a real-target profile that requires authentication.
`Validator.validate()` replays it before the finding's own triggering
steps, reconstructing client-side state (e.g. a filter selection) a
direct `goto()` alone would not restore. Not a general graph planner — no
search across the app's page graph. A prerequisite step that fails (e.g.
policy-denied) is `toolingBlocked`, feeding into §4a's handling — never a
false rejection.

### §5 — UI/UX closure and fixture parity

**Confirmed gaps and fixes**:
- No evidence links/previews on result cards → each finding card now
  links every persisted evidence file through the existing artifact
  route; a screenshot renders inline.
- No active-run recovery on page refresh → `GET /api/runs`'s existing
  `activeRun` field (server-side was already correct) is now checked on
  page load; the client restores the live-progress view and
  resubscribes.
- Status polling returned identity only, not live counters → `RunManager`
  now stores each run's last `RunProgressEvent`; `GET /api/runs/:id/status`
  and `GET /api/runs` both surface it.
- Profile list omitted provider/model identity → `GET /api/profiles` now
  includes it; rendered in the profile dropdown.
- Fixture preflight always failed its target-reachable check (the
  fixture's server only starts inside a run) → new `"managed"`
  `PreflightStatus`, never blocking `overallReady`, for a local-fixture
  profile specifically; a real-target profile's target-reachable check is
  still actively probed and can still genuinely fail.
- `RunManager.startRun()` never enforced preflight (purely advisory in
  the UI) → now enforced server-side; a genuine `"fail"` check (never
  `"managed"`/`"skipped"`) refuses the start with a `PreflightFailedError`
  naming the failing check(s), checked against the effective selected
  mode (Demo forces mock providers first, so Demo never needs live
  credentials to pass).
- `profileToAppConfig()` hardcoded empty oracle rules/patterns for every
  profile, including the fixture → a local-fixture profile now reuses the
  exact same rules `qa.config.mock.yaml` declares (`src/
  fixture-oracle-config.ts`), with a parity test asserting the two never
  drift apart; a real-target profile correctly keeps empty defaults
  (nothing to seed rules from).
- `buildPilotSummary()` was dead code, reachable only from its own test →
  wired into `assembleReport()`, writing `pilot-summary.json` for any
  non-fixture profile. Its `workflows` field (renamed `heuristicCoverage`)
  no longer claims heuristic-candidate counts ARE business-workflow
  coverage — the prior wording was confirmed overclaiming per the
  review's explicit instruction not to call generated heuristic
  combinations business-workflow coverage; no declared-workflow manifest
  exists in this codebase.

**A genuine bug found only via real-browser testing (not caught by any
HTTP-level test)**: the Orchestrator emitted its terminal progress event
(`this.progress(ctx, ...)`) BEFORE transitioning `ctx.state` to its
terminal value, so `phaseForState(ctx.state)` still saw the prior
(non-terminal) state — the client's SSE listener never received a
`phase:"completed"`/`"stopped"`/`"failed"` event and the UI simply froze
on the last real progress line indefinitely (the SSE connection is never
explicitly closed by the server either, so no `onerror` fallback fired).
Fixed by transitioning first, then emitting progress against the new
state, in all three exit paths (`continueOrStop()`, the user-Stop check,
and the step-failure catch block). A second, related race was then found
and fixed: the client's SSE handler called `finishRun()` (which fetches
`report.json`) immediately upon the terminal event, but `assembleReport()`
(which writes `report.json`) runs afterward in `RunManager.executeRun()`
— the client now hands off to the same `pollStatus()` polling loop the
SSE-drop fallback already uses, which correctly waits for `GET
/api/runs/:id/status`'s `active` flag (synchronized with
`assembleReport()`'s completion) before declaring the run finished. Both
fixes were verified live in a real browser: started a run, refreshed
mid-run (active-run recovery), watched it complete with a correct
"Completed" status line, and opened evidence links on the resulting
finding cards.

**Not done this continuation, disclosed as a real gap**: no profile
create/edit UI (`POST /api/profiles`) — a profile is still authored by
hand as JSON. This was scoped out of this pass given its size; creating
scoped-down real-target profiles safely (declaring `allowedPathPrefixes`/
`allowedApiOrigins`/`allowedWorkflowKinds`/`allowedFormSubmitEndpoints`
correctly) is exactly the kind of task a guided form would materially
help with, and is the clearest remaining UI gap for Phase 5.

## What the 2026-09-14 addendum fixed

A **follow-up addendum** (2026-09-14) re-examined specifically the
navigation/redirect policy and preflight-ordering work from the
2026-09-11 continuation above, using real Chromium probes against
disposable local servers rather than trusting the targeted tests that had
already passed. It found both claims of completion premature, and named
several other items from the original review as still open or not yet
implemented despite earlier characterization. This section documents what
that addendum found and what actually closes it now — using the numbering
in `PHASE4_REVIEW_ADDENDUM_2026-09-14.md` itself, which is a **different**
numbering scheme from this document's own §1–§5 headers above (the
addendum's §1/§6 concern navigation/redirect and preflight-ordering, not
the click/fill action-policy §1 above).

### Correcting the record: §1/§6 were not actually complete

The 2026-09-11 continuation's own targeted tests for navigation policy and
preflight ordering passed 49/49 at the time, and were reported as
"Complete" above. **That was premature.** The addendum's real-Chromium
probe (an allowed `/allowed/start` responding with a 302 to an
out-of-scope `/blocked/destination`) showed the forbidden destination
receiving a genuine request, with policy checked only once, for the
original URL — `context.route()`'s handler does not re-fire for a
redirect's own destination; the browser follows a redirect natively once
the first hop's response is relayed to it. An earlier code comment in
`src/safety/navigation-guard.ts` asserting the opposite was simply wrong,
and a design-validation pass earlier in this project made the same wrong
assumption. Separately, `checkScopeConsistency()` in
`src/preflight/doctor.ts` checked origin but never path scope, so an
allowed-origin/out-of-scope-path target still got probed. Both are fixed
below, verified this time by counting real hits on a disposable server
(not by inspecting Playwright-side request events, and not by
post-navigation correction) — the addendum's own explicit methodology
requirement.

### §1a — Redirect-chain policy bypass

**Fix**: `installRouteGuard()` (`src/safety/navigation-guard.ts`) no
longer relies on Playwright re-invoking the route handler per hop.
`chaseAndValidate()` manually walks the chain itself: it classifies the
request's own URL, then fetches it via `route.fetch({ maxRedirects: 0 })`
(never letting the browser touch it directly); if the response is a
redirect, it resolves and **classifies the destination BEFORE ever
fetching it** — a denied destination aborts the original route
immediately, so it is never fetched by AutoQA or the browser. An allowed
chain is walked recursively (bounded to 20 hops, denying a chain that
exceeds it) until every hop is confirmed in-scope, then only the **first**
hop's already-fetched real response is relayed via `route.fulfill()`,
letting the browser follow the rest of the chain natively — this is what
keeps `page.url()` correct for a legitimate chain (critical for
`FormLoginBootstrap`'s `page.waitForURL(successUrlPattern)` after a
post-login redirect) while still guaranteeing every hop was pre-validated.
The trade-off (one redundant validation fetch per in-scope hop) is
disclosed in the function's own doc comment.

**Evidence**: `tests/safety/action-policy.test.ts`'s new
"redirect-chain policy enforcement" tests hit a real local HTTP server
with a request counter and assert **zero hits** on a forbidden
destination for a same-origin redirect, an off-origin redirect (a
separate server), a 307, and a 308; a legitimate fully-in-scope chain
completes with `page.url()` correct; a 307 POST preserves its method
end-to-end (with the disclosed 2-hits trade-off asserted explicitly); and
a chain exceeding the hop cap is denied rather than looping.

### §1b — Direct `"navigate"` action skipped the workflow-kind check

**Fix**: `ActionPolicy.classifyAction()` gained an explicit
`action.type === "navigate"` branch requiring
`workflows.allowedWorkflowKinds.includes("navigate")`, mirroring the check
a link-click navigation already enforced.

### §1c — `"fill"` always allowed once in path-scope (disclosed, not code-fixed)

A `fill` action never itself causes a network request — only a subsequent
click/press/submit does, and that is fully policed (further strengthened
by §1a). The residual risk (an app wiring `fetch()` directly to a keystroke
handler) is still caught by the network-layer defense regardless of what
`classifyAction` says about the fill itself. No clean, bounded criterion
exists for "which fills are dangerous" beyond what that layer already
catches, so this is a considered, disclosed decision, not a silently
dropped gap.

### §6a — Preflight scope-consistency ignored `allowedPathPrefixes`

**Fix**: `checkScopeConsistency()` (`src/preflight/doctor.ts`) now also
checks the target's path against `navigation.allowedPathPrefixes` via the
existing `pathWithinPrefix()` helper, failing before any reachability
probe is ever issued.

**Evidence**: `tests/preflight/doctor.test.ts`'s new test asserts a
`fetch` spy sees **zero** calls to an out-of-scope path on an otherwise
allowed origin, and `target-reachable` reports `"skipped"`.

### §6b — 3xx reachability wording

**Fix**: `checkTargetReachable()`'s detail message for a 3xx response now
explicitly states this confirms only that the server responded, not that
the redirected destination is reachable, in scope, or authenticated.

### §5 + §8b — RunManager TOCTOU race, runId collision, dishonest failure-path usage

The addendum found the 2026-09-11 continuation's own claimed fix for the
`startRun()` race was **never actually applied** — only its imports had
landed; the check-then-await-then-assign race was still present on disk.

**Fix**: a synchronous `private starting = false` flag closes the window
completely — `startRun()` checks and reserves in one synchronous step
before any `await`. `generateRunId()` (`src/report.ts`) keeps millisecond
resolution instead of stripping it, for defense in depth. Separately,
`executeRun()`'s catch block previously always reported zero usage on
failure regardless of whether `runPipeline()` had actually completed with
real recorded usage before only `assembleReport()` failed; it now builds
the fallback summary from `pipelineResult.usageTracker`/`.budget` when
available.

**Evidence**: `tests/run-manager.test.ts`'s new concurrent-call test fires
two `startRun()` calls with no `await` between them and asserts exactly
one succeeds, one rejects `RunAlreadyActiveError`, and exactly one run
directory is created — a genuine race test, not a sequential-call test. A
second new test forces `assembleReport()` to fail once after a real run
completed and asserts the fallback summary's usage reflects what actually
happened.

### §3 — phase2-experiment.ts bypassed live-gating

Named as still-open by the addendum's "other status observations" (the
original review's fix mirrored `phase3-experiment.ts` but never touched
this file). **Fix**: `assertLiveModeAuthorized()` is now called up front
in `main()`, mirroring the already-fixed `phase3-experiment.ts` pattern.
Verified via a spy asserting `runPipeline()` is never called when a live
explorer is configured without `--live`.

### §2 — Secret leakage via unredacted URLs/metadata

**2026-09-15 correction — the fix below, as originally written, was
itself a regression.** Redacting `Observation.page.url`/`.title`/
`links[].href` **in place** (as this section originally described)
corrupts the *same* values every other subsystem reads to actually act:
`orchestrator.ts` pushes `links[].href` into `ctx.frontier`;
`planner.ts` builds a `"navigate"` candidate's `actions[0].url` directly
from it; `actions.ts#executeAction()` calls `page.goto(action.url)` on
it. A link whose href happened to contain the run's own credential (or
merely matched `redactSecrets()`'s unconditional generic `token=`/
`password=`/`secret=`/`authorization=` pattern) became a navigation to a
broken, literally-`<REDACTED>`-containing URL — live exploration
silently went to the wrong place. The same corruption applied to
`Finding.url`, which `Validator.validate()` later `page.goto()`s during
clean-session replay: a finding recorded on a credential-bearing URL
could never be correctly replayed again. No test caught this because
existing redaction tests only asserted the *security* property (the
secret is gone), never the *operational* property (navigation/replay
still reaches the intended page) — see `PHASE4_FINAL_ACCEPTANCE.md` for
the full account of how this was found and fixed this pass. The
corrected architecture is below; treat the "Fix" paragraph as describing
the **current, corrected** state, not the 2026-09-14 addendum's original
text.

**Confirmed gap, larger than the review's own probe**: `Observation.page.
url`/`.title` were never redacted; `attachPageRecorders()` redacted
`text`/`message` for console/pageerror/dialog events but not `url` for
network requests — the one asymmetric gap; `links[].href` was never
redacted. These cascaded into the Explorer's live prompt, `PageMapper`'s
`applicationMap`, `Finding.url`, and both oracle files'
`details.newFailures[].url`. `report.json`/`report.md` had no redaction
pass at all (unlike per-finding evidence files), nor did
`benchmark.json`/`phase2-metrics.json`/`grouping.json`/`pilot-summary.json`.
Separately, `src/report.ts#writeFindingJson()` was found (2026-09-15) to
apply **zero** redaction, unlike `src/evidence.ts#writeJson()`'s already-
correct pattern — the same class of gap, closed in the same pass.

**Fix (corrected 2026-09-15) — redaction moved to the actual boundaries,
`Observation` itself stays raw/operational**: `observe()`
(`src/browser/observation.ts`) no longer redacts `page.url`/`.title`/
`links[].href` — these stay the real, operational values Playwright
returns. `pathname` (already computed from the raw URL) was never
affected either way. `attachPageRecorders()`'s `NetworkRecord.url`
redaction at capture is unchanged and remains safe (never reused to make
a request). Redaction is instead applied at genuine boundaries: `src/
explorer.ts#formatUserMessage()` now redacts `url`/`title` (via a new
`ExplorerInput.extraSecrets` field) at the point they're interpolated
into the model prompt; `src/qa/planner.ts`'s `Planner` (now constructed
with an `extraSecrets` parameter) builds each navigation candidate's
model-facing `id`/`description` from the **redacted** href while
`actions[0].url` stays the **raw** href actually passed to `page.goto()`
— the model only ever sees/echoes a redacted candidate id, and matching
still works since both sides use the same redacted string;
`writeReportJson()`/`writeReportMarkdown()`/`writeFindingJson()` and
every raw `JSON.stringify` write in `src/reporting/assemble.ts` still
take an `extraSecrets` parameter and redact before writing, unchanged
from the addendum's original description; `RunManager.executeRun()`
still threads `credentialSecrets(input.credentials)` through to
`assembleReport()`.

**Evidence**: `tests/security/secret-redaction.test.ts`'s redaction-
boundary tests (rewritten 2026-09-15) now assert the *inverse* of the
addendum's original claim for `Observation.page.url`/`links[].href` —
that they stay raw/correct — while proving the *operational* property
directly: a credential-bearing href still produces a successful
`page.goto()` to the real page when its navigation candidate is chosen,
and a `Finding` recorded with a credential-bearing `url` still replays
correctly via `Validator.validate()`. The prompt/report/evidence-side
security property (the addendum's original concern) is verified
separately: the formatted Explorer prompt (both the `url:`/`title:`
lines and the candidate list), `report.json`, `report.md`,
`benchmark.json`, `pilot-summary.json`, and now `finding.json` are all
confirmed credential-free.

### §7 — Validator replay boundary, prerequisite filtering, decideStatus eagerness

**§7a**: `Validator.validate()` used to capture `before` immediately after
`goto()`, ahead of prerequisite-step replay — a prerequisite that
succeeded but incidentally produced a side effect matching the oracle's
own signature (e.g. a console error) fell inside the same before/after
window as the actual trigger, risking misattribution as reproduction.
**Fix**: prerequisites now replay first; `before` is captured only once
they succeed, narrowing the oracle's comparison window. Verified with a
page where the prerequisite click alone trips the oracle and the trigger
click does nothing further — the finding correctly reads as not
reproduced/rejected, where it would previously have falsely validated.

**§7b**: `computePrerequisitePrefix()` was an unfiltered tail slice of
recorded steps — it could include a step whose `executeAction()` was
blocked/failed, and had no state-coherence anchor. **Fix**: `RecordedStep`
gained an optional `outcome` field, populated from the actual
`executeAction()` result; the prefix logic (factored out as the pure,
directly-unit-tested `selectPrerequisitePrefix()`) now filters to
successful steps and anchors on the most recent `"navigate"` before
capping at 8 steps.

**§7c**: `decideStatus(0, 1, 2)` (a single genuinely-executed negative
attempt, with the other configured attempts tooling-blocked) returned
`"rejected"` — a confident-sounding disproof from just one real attempt.
**Fix**: `decideStatus()` now requires `validAttempts >= minimumSuccesses`
before considering a rejection, the same evidence bar §4a already applies
to a confident validation.

### §8a — FormLoginBootstrap had no cancellation path

**Fix (2026-09-14)**: `SessionBootstrap.establish()` and `BrowserManager.
newPageSession()`/`ensureAuthenticated()` gained an optional `signal`
parameter; an already-aborted signal at entry returns a new `"cancelled"`
`AuthResult` reason without attempting any Playwright action, and the
retry loop checks the signal between `MAX_LOGIN_ATTEMPTS` attempts,
starting no new attempt after Stop (an attempt already in flight still
completes on its own timeout — bounded cleanup, not instant
interruption, consistent with how cancellation already worked elsewhere
in this project). Threaded from `Orchestrator.initialize()` and
`Validator.validate()`'s per-attempt session creation.

**2026-09-15 correction — "between whole attempts" was not yet a
practical bound.** The above closed the gap in principle but left the
worst case large and undocumented: one in-flight login attempt is the
sum of all its own step timeouts (~80s), and one in-flight replay
attempt is the sum of its own (~40s) — Stop was only ever checked
*between* attempts, never *within* one. **Fix**: `executeAction()`
(`src/actions.ts`) gained an optional `signal` parameter, checked at
entry before touching Playwright; `FormLoginBootstrap.establish()`
(`src/auth/session-bootstrap.ts`) now checks `signal?.aborted` after each
of its 5 major steps (`goto`, both `fill`s, `click`, the
`waitForURL`/signal-visibility pair); `Validator.validate()`'s two replay
loops and `Orchestrator.execute()`'s action loop now thread
`this.deps.abortSignal` into every `executeAction()` call and check
before each iteration. Claimed bound at the time: "Stop takes effect
within one in-flight step's own timeout — ≤15s during login, ≤5s during
replay/exploration."

**2026-09-16 correction — the ≤15s/≤5s claim above was itself false for
an already-in-flight step.** An independent real-Chromium probe requested
Stop during a 10-second `wait` action and found `executeAction()` still
returned success ~9.9s later — the "between steps" checks added on
2026-09-15 only ever prevented the *next* step/action from starting; they
were never wired into whichever Playwright call was already in flight
when Stop fired, so that call still ran to its own full timeout (or, for
`page.waitForTimeout()`, its full duration) regardless. **Fix**: every
Playwright call `executeAction()`/`FormLoginBootstrap.establish()`/
`ensureAuthenticated()` makes that supports it (`Locator.click`/`.fill`/
`.press`/`.waitFor`, `Page.goto`/`.reload`/`.waitForURL` — confirmed
against the installed `playwright-core`'s own type definitions) now
receives `signal` directly in its options object, so Playwright itself
aborts the in-flight operation the moment Stop fires; `page.
waitForTimeout()` (the one call with no native `signal` hook) was
replaced with a `Promise.race`-based `abortableDelay()` helper. A shared
`isCancellationError()` helper (checking Playwright's own `AbortError`,
confirmed via its source) distinguishes a genuine cancellation from a
real locator/navigation failure at every catch site, including one
pre-existing, unrelated mislabeling bug this work exposed and fixed in
the same pass: a login cancelled via `ensureAuthenticated()`'s retry
loop threw `AuthenticationError{reason:"cancelled"}`, which
`Orchestrator.initialize()`'s catch block mapped to FSM state `FAILED`
— a cancelled run's report must say "stopped," never "failed" (see
`states.ts`'s own doc comment); this now correctly maps to `CANCELLED`.

**New, wall-clock-verified bound: Stop interrupts whatever is currently
in flight, typically within ~0.5–2 seconds regardless of that
operation's own timeout or configured duration** — not "the next unit of
work never starts" (the 2026-09-15 framing) but genuine mid-operation
interruption. Proven, not asserted: `tests/actions-cancellation.test.ts`
(new) wall-clock-measures a 10-second `wait` action, a navigation and a
reload against a server that never responds, and a click waiting on an
element that never appears — every one returns in under 2–3 seconds with
a `CANCELLED`-labeled reason, and the entire 5-test file runs in ~4.4s
total (proof no test ever fell through to its full timeout).
`tests/auth/session-bootstrap.test.ts` and `tests/validator.test.ts`
gained equivalent tests for login and replay specifically, each stalling
the relevant step's own server response so the abort fires while
Playwright's own call is genuinely in flight, not merely about to start.

### §4 — Budget checked once per logical decision, not once per real HTTP request

**Confirmed gap**: `BudgetTracker.canCallModel()`/`recordModelCall()` (and
the critic-side equivalents) were checked/recorded exactly once around
`Explorer.decide()`/`Critic.review()`, but a real provider's
`decideNextAction()`/`critique()` can internally issue two real HTTP
requests (first attempt + repair) via its own `complete()` method — a
`maxModelCalls: 1` budget could silently permit 2 real requests.

**Fix**: `BudgetTracker` is now threaded as a 5th constructor parameter
into all four real providers (`AnthropicModelProvider`/
`ExplabsModelProvider`/`AnthropicCriticProvider`/`ExplabsCriticProvider`),
mirroring `usageTracker`'s existing pattern. Each provider's `complete()`
checks-then-reserves budget immediately before issuing its own real
request; a request that would exceed the budget throws a new
`ModelBudgetExhaustedError`/`CriticBudgetExhaustedError`
(`src/budget.ts`) without ever being sent. `Explorer.decide()` and
`Critic.review()` catch these and convert them to a clean stop/unavailable
outcome, never a crash. The orchestrator-side and critic-runner-side
explicit `recordModelCall()`/`recordCriticCall()` calls are now
diff-based fallbacks (`if (budget.modelCalls === before) recordModelCall()`)
rather than unconditional — a real provider's own recording is never
double-counted, while `MockModelProvider`/`MockCriticProvider` (which
touch no budget themselves) still consume exactly one logical call per
decision, preserving existing budget-limiting semantics for mock-driven
runs. `run-pipeline.ts` and `experiments/conditions.ts` both construct
`BudgetTracker` before calling `selectProvider()`/`selectCriticProvider()`
now, so it exists in time to be threaded in.

**Evidence**: `tests/models/provider-implementation.test.ts`'s new tests
prove `maxModelCalls: 1` permits exactly 1 real request (then throws)
for a first-attempt-then-repair decision, `maxModelCalls: 2` permits
exactly 2, and a mock-only run consumes zero budget.
`tests/explorer-budget.test.ts` proves `Explorer.decide()` converts the
provider's error into a clean stop, never a crash.
`tests/critic/critic-runner-cancellation.test.ts`'s new tests prove the
same clean-conversion behavior on the critic side, and specifically that
a real provider's own recorded call is never double-counted by the
diff-based fallback. `tests/experiments/conditions-budget.test.ts`'s
pre-existing `MockCriticProvider`-based budget-enforcement test (which
this fix's design was explicitly validated against beforehand) still
passes unmodified. **Scope note**: exact-request-count coverage was built
for `AnthropicModelProvider` specifically; `ExplabsModelProvider` and both
critic providers share the identical `complete()`-boundary pattern
(confirmed by full-suite passing and typecheck), but do not each have
their own dedicated exact-count test — a disclosed, not silently
skipped, scope decision.

### §9 — Hardcoded test-server ports (scoped fix)

`startFixtureServer()` (`fixture/server.ts`) now defaults to port `0`
(OS-assigned) and returns the actual bound port. Tests that manage their
own fixture-server lifecycle independently of `runPipeline()`'s
local-fixture auto-start path were converted to use it (e.g.
`tests/reporting/assemble.test.ts`'s pilot-wiring test). Tests that MUST
go through that auto-start path keep their existing distinct hardcoded
ports, since the port must be decided in `config.target.url` before the
server exists — an inherent ordering constraint, not an oversight.
`tests/helpers/ports.ts` is a new, non-imported central registry
documenting every literal port still in use, so a future addition picks
an unused one deliberately.

## What this pass (2026-09-15) fixed

A third pass, prompted by an instruction to treat "62 files / 513 tests
pass" as a reported result to verify, not proof of completion. Found one
severe regression the 2026-09-14 addendum's own redaction fix had
introduced (§2 above, corrected in place) and one previously-undiscovered,
pilot-blocking bug, plus closed several disclosed-but-open gaps.

### The regression: redaction corrupting operational navigation/replay

Covered in full under the corrected §2 section above. Root cause,
fix, and evidence are documented there rather than duplicated here.

### A previously-undiscovered bug: `profiles/orangehrm.json` denied its own login

**Confirmed gap**: the profile declared no
`resources.allowedFormSubmitEndpoints` entry for its own login POST
(`/web/index.php/auth/login`). `installRouteGuard()`'s resource policy
applies to the login request itself — login is deliberately not exempt
("authentication exceptions remain narrow") — so a real run against this
profile would have had its own login denied by its own policy, regardless
of correct credentials. This survived three prior review passes because
every existing auth test called `newPageSession(undefined, undefined,
...)` with `actionPolicy` explicitly `undefined` — no test exercised
`FormLoginBootstrap` with a real `ActionPolicy`/route-guard active at the
same time.

**Fix**: added the missing `allowedFormSubmitEndpoints` entry to
`profiles/orangehrm.json` (a disclosed placeholder pathname, same
confidence level as the profile's other locator placeholders — confirm
once a real instance is reachable, per `docs/ORANGEHRM_PILOT_SETUP.md`).
Two new integration tests in `tests/validator-auth.test.ts` drive
`FormLoginBootstrap` through the **full stack** (route guard + action
policy + login together, not in isolation) — one proves the original bug
(login denied without the allowlist entry), one proves the fix (login
succeeds with it).

### Request deadline vs. remaining run budget

**Fix**: `Math.min(providerTimeoutMs, budget.remainingDurationMs())` is
now computed before `deriveTimeoutSignal()`/`withTimeout()` at all three
call sites (`orchestrator.ts#explore()`, `critic-runner.ts#review()`,
`experiments/conditions.ts`) — a provider request's own timeout can no
longer exceed the time actually left in the run. `experiments/
conditions.ts`'s critic call previously passed no cancellation signal at
all despite a comment claiming parity with the live path; it now does.

### `generateRunId()` collision resistance

**Fix**: appended a random 4-hex-char suffix (`crypto.randomBytes(2)`) —
collision resistance is now a property of the function itself, not only
an emergent property of `RunManager`'s own synchronous `starting` guard
(which left other direct callers — `index.ts`, `benchmark.ts`,
`phase3-experiment.ts` — unprotected). Confirmed no downstream code
parses a run ID's internal structure via regex.

### Redirect-safety test gaps closed

Three narrow gaps identified by this pass's own review, closed in
`tests/safety/action-policy.test.ts`: a 307/308 redirect to a genuinely
different origin (previously only out-of-scope-*path* redirects were
tested for 307/308); a terminal (non-redirecting) request asserting
exactly one hit (proving `chaseAndValidate()`'s non-redirect path doesn't
double-fetch); a native-form submission asserting the target server
actually received the submitted field value in its POST body, and that a
cookie set by the origin server survives through the manual
`route.fetch`/`route.fulfill` relay to the terminal request.

### Test-port doc cleanup

Removed the stale `4203` row from `tests/helpers/ports.ts` (nothing binds
that port anymore) and fixed two comments elsewhere that still cited it.

### Profile create/edit UI (closes a gap disclosed since 2026-09-11)

**New**: `POST /api/profiles` (create or overwrite-by-id) and `GET
/api/profiles/:id`, thin wrappers around the already-working
`ProfileStore.save()`/`load()`. A new "1b. Create / edit project" section
in `src/server/public/index.html` provides quick fields (id, name, target
URL, environment kind) plus a full-JSON textarea as the single source of
truth for every other field (navigation scope, auth locators, workflow
kinds, provider, limits) — kept genuinely minimal rather than replicating
the entire schema as form controls. Editing an existing profile disables
the id field (preventing an accidental silent fork). A validation error
(e.g. a missing `navigation.allowedOrigins`) renders inline, not as a
silent failure or a crash.

**Verified live in a real browser** (Claude Browser MCP, not just HTTP
tests): created a new profile, confirmed it appeared in the profile
dropdown with correct identity, edited its name, confirmed the change
persisted via `GET /api/profiles/:id`, and confirmed `npm run doctor`'s
equivalent in-UI "Check setup" flow ran correctly against the new
profile end-to-end (schema → Chromium launch → navigation-scope
consistency → provider resolution, `Overall: READY`).

**A real bug found only by this live-browser exercise, not by any
existing test**: `ProfileStore.list()` (`src/profiles/store.ts`) filtered
directory entries by `f.endsWith(".json")`, which also matched the new
declared-workflow manifest file, `profiles/orangehrm.workflows.json`
(added earlier in this same pass — see below). `GET /api/profiles`
consequently 500'd on every request, since the manifest's shape (`
workflows: [...]` as an array) fails `parseProfile()`'s schema (which
requires `workflows: {allowedWorkflowKinds: [...]}`). **Fix**: `list()`
now excludes files ending in `.workflows.json`. A new regression test
(`tests/profiles/store.test.ts`) reproduces the exact failure (a sibling
manifest file breaking `list()`) and asserts the fix.

### Declared-workflow manifest

**New module** `src/pilot/workflow-manifest.ts`: a zod-validated
`WorkflowManifest` (`<profileId>.workflows.json`, loaded via
`loadWorkflowManifest()`, honestly `undefined` when absent — never
fabricated) and per-run `saveWorkflowStatus()`/`loadWorkflowStatus()`
mirroring `src/human-review/triage.ts`'s exact `runDir`-scoped JSON-file
pattern (one file per run, redacted on write). `PilotSummary`
(`src/reporting/pilot-report.ts`) gained a new `declaredWorkflows` field
— entirely separate from `heuristicCoverage`, honestly
`{manifestPresent: false}` when no manifest exists for the profile (the
fixture case). Ten new unit tests across `tests/pilot/
workflow-manifest.test.ts` and `tests/reporting/pilot-report.test.ts`.

**Concrete deliverable**: `profiles/orangehrm.workflows.json` — a real,
5-page/10-workflow manifest (login, dashboard navigation, employee-list
search/sort/paginate/filter, leave-list navigation/filter, timesheet
navigation, reload-state handling) with genuine preconditions/authorized-
actions/expected-outcome text, matching `docs/ORANGEHRM_PILOT_SETUP.md`'s
own already-stated "intended workflow set." It has not been run (the
target isn't reachable — see Milestone C below); every workflow's status
stays unrecorded until a real run happens.

## What this pass (2026-09-16) fixed

A fourth pass, redirected by explicit user instruction: defer the
OrangeHRM pilot entirely (see Milestone C below) and focus on making
AutoQA a reliable, usable *local* QA application — genuine cancellation,
closing the remaining test-port collisions, and a real-browser-verified
ordinary-user journey with any concrete gap found actually fixed, not
just noted.

### Cancellation made genuinely mid-operation, not just between-step

Covered in full under the corrected §8a section above (the real-Chromium
probe that found the 2026-09-15 bound false, the fix, and the new
wall-clock-verified ~0.5–2s bound). One pre-existing bug surfaced and
fixed in the same pass: a login cancelled via `ensureAuthenticated()`'s
retry loop was mapped to FSM state `FAILED` instead of `CANCELLED` in
`Orchestrator.initialize()`'s catch block — a cancelled run's report must
say "stopped," never "failed."

### Preserved partial results/usage after cancellation — verified, not just claimed

`tests/run-manager.test.ts`'s existing "cancellation actually stops a run"
test only asserted `status === "cancelled"`; strengthened to also assert
`actionsPerformed`/`budget.actionsUsed` are genuinely non-zero (not the
old unconditional-zero fallback) after a real mid-run Stop. Confirmed
live in the browser walkthrough below: a cancelled fixture run retained
**5 validated findings** and a full budget/usage snapshot — cancellation
was never silently discarding what the run had already found.

### Test-owned port isolation — the remaining six hardcoded ports retired

**Root cause**: `runPipeline()` (`src/run-pipeline.ts`) derived a
local-fixture target's fixture-server port from `config.target.url`'s own
literal value, so every test that needed its own fixture server had to
hand-pick a port distinct from every other concurrently-running test file
purely to avoid `EADDRINUSE` — six such ports were catalogued in
`tests/helpers/ports.ts`.

**Fix**: `runPipeline()` now always binds a local-fixture target's server
to an OS-assigned port (0), then substitutes the real bound origin back
into `config.target.url`/`config.safety.allowedOrigins` **in place**,
before anything downstream reads it (`config` is captured by reference
and read lazily by every consumer, confirmed by direct source reading —
no construction-order changes were needed elsewhere in the function).
Every other environment (`self-hosted-real-app`/`owned-sandbox`) never
enters this branch, so a real user's own configured port is completely
untouched. This makes a local-fixture config/profile's own literal port
**inert placeholder text** — the six existing hardcoded-port test files
needed *no logic changes at all* to become collision-free (confirmed:
the full suite passes with all of them running concurrently, as vitest
does by default). `tests/helpers/ports.ts` now documents zero reserved
ports, with an explanatory note for why; a manual port-remap workaround
in `tests/security/secret-redaction.test.ts` (there specifically to dodge
a real, previously-reproducible collision with another test's use of
port 4173) was removed as no longer necessary.

**New regression test proving genuine isolation, not just absence of
failure**: `tests/run-pipeline-port-isolation.test.ts` runs two
local-fixture `runPipeline()` calls concurrently, both declaring the
exact same placeholder port, and asserts both succeed on two distinct
real ports. Also confirmed on the actual production CLI path: `npm run
qa -- --config qa.config.mock.yaml` (whose YAML still declares the
original `4173`) ran against a dynamically-assigned port (`53823` in one
verification run) with identical findings/precision/recall to every
prior baseline.

### Ordinary-user journey — real-browser-verified end to end, one gap found and fixed

Walked the full journey in a real browser (Claude Browser MCP) against
**two** targets: the bundled `fixture` profile, and a newly-created
`owned-sandbox` profile pointed at a disposable local Node HTTP server
(never `local-fixture`, which never constructs an `ActionPolicy` — using
it for this walkthrough would have silently skipped scope enforcement
verification). Confirmed working: profile create/edit with explicit
`navigation.allowedOrigins`/`allowedPathPrefixes`/`resources.
allowedApiOrigins`/`allowedFormSubmitEndpoints` scope, a real inline
schema-validation error render, provider identity/limits visible before
starting, "Check setup" genuinely probing a real target's reachability
(not just the fixture's managed `~`), a mock run actually exploring the
real disposable server (2 pages, 1 action, 0 findings — an honest result
for a near-empty demo page), active-run recovery on page refresh (mid-run
counters and Stop access both survived a full page reload), Stop halting
within ~2 seconds with the run correctly labeled "cancelled" and its 5
findings-so-far preserved, and each result card's inline screenshot
resolving through the artifact route (confirmed via a direct HTTP request
returning a real `image/png`).

**A genuine usability gap found by this walkthrough, not by any prior
pass**: the "Prior runs" list renders every run returned by `GET
/api/runs` with no limit and no scroll container — in this development
environment, 60+ accumulated runs made the page grow to several times a
normal screen's height, pushing the actual run controls and results out
of easy reach. **Fix**: `#prior-runs` (`src/server/public/index.html`)
gained a bounded, scrollable container (`max-height: 320px; overflow-y:
auto`) — every run stays reachable (nothing paginated away or hidden,
consistent with "reuse the existing interface... avoid an unrelated
redesign"), but the page itself no longer grows unbounded. Confirmed live
(`clientHeight: 305` vs `scrollHeight: 6459` for the full accumulated
list).

## Milestone C — OrangeHRM real-application pilot (deferred by user, 2026-09-16)

**As of 2026-09-16, this milestone is explicitly deferred by the user's
own instruction, not merely blocked by environment.** The governing
instruction for the 2026-09-16 pass: "I am explicitly deferring OrangeHRM
and its real-application pilot. Do not install OrangeHRM, investigate its
dependencies, or let it block further work. Preserve the existing pilot
files for later and mark this acceptance item 'deferred by user,' not
completed." Accordingly, no OrangeHRM-related investigation, installation
attempt, or dependency check occurred in that pass; every file below is
exactly as the 2026-09-15 pass left it, confirmed via `git diff` showing
no changes from this pass. Everything documented below reflects state as
of 2026-09-15, the last pass that actually touched this milestone.

Complete: `profiles/orangehrm.json` (adapter, pure profile data),
`src/reporting/pilot-report.ts` (N/A precision/recall/F1 with a stated
reason, never fabricated; separately-denominated human-acceptance field;
never references the fixture's own answer-key file — enforced by a
dedicated security test; now actually wired into report assembly),
`docs/ORANGEHRM_PILOT_SETUP.md` (setup options, intended workflow set,
full acceptance checklist). §1-§4b's fixes (real policy enforcement,
prerequisite-prefix replay, honest pilot-report wiring) are what make an
eventual pilot run both safe and honestly reported.

**Pending, and why**: rechecked 2026-09-11, 2026-09-14, and again
2026-09-15 (identical result each time) — `docker`, `docker-compose`,
`php`, and `mysql` all still fail with "command not found" in this
environment; `docker`'s own referenced install directory
(`C:\Program Files\Docker\Docker`) does not exist on disk. No owned or
otherwise-reachable OrangeHRM instance is known to this environment
either. No public hosted demo was used or considered as a substitute —
per instruction, and no privileged software was installed to work around
it. The 2026-09-15 pass fixed the profile's own pilot-blocking login-
policy bug (`allowedFormSubmitEndpoints`, see above) and authored the
real `profiles/orangehrm.workflows.json` declared-workflow manifest —
both are independent of the environment blocker and are done. Every
acceptance item that requires an actual instance (doctor READY, locator
verification, the full preflight-through-report demonstration, a
real-or-controlled-fault replay, and now each declared workflow's real
attempted/completed/blocked/unsupported status) is listed as pending in
`docs/ORANGEHRM_PILOT_SETUP.md`'s checklist, not attempted and not
claimed.

## Milestone D — Bounded live use, usage accounting, human triage

- **D1**: see §3 above for the continuation's accounting/cancellation/
  live-gating fixes. From the original pass: all three provider SDK
  clients set `maxRetries: 0`; `src/experiments/conditions.ts
  #runCondition()` shares `withTimeout()` and a per-condition
  `BudgetTracker` with the live path; `src/models/pricing.ts`'s table is
  deliberately empty, so `estimatedCostUsd` is `null` with a stated
  reason unless a real rate is added.
- **D2**: unchanged this continuation. `import-cli.ts`'s ground truth is
  explicit and optional; `"unsure"` is preserved as its own denominator;
  unknown item ids and conflicting duplicate labels are rejected; a
  repeat identical submission is deduped. `src/human-review/triage.ts`
  for ordinary (non-blind) manual labels, surfaced in the UI, never
  touching the blind-review pipeline.

## Known limitations (carried forward, disclosed, not silently fixed)

- OrangeHRM live-pilot acceptance was pending environment availability
  through 2026-09-15 (Docker/PHP/MySQL all absent here) and is, as of
  2026-09-16, **explicitly deferred by the user** — a scope decision, not
  (only) an environment limitation: "I am explicitly deferring OrangeHRM
  and its real-application pilot. Do not install OrangeHRM, investigate
  its dependencies, or let it block further work." All pilot-specific
  files (`profiles/orangehrm.json`, `profiles/orangehrm.workflows.json`,
  `docs/ORANGEHRM_PILOT_SETUP.md`) are preserved untouched from the
  2026-09-15 pass for whenever this work resumes. See
  `docs/ORANGEHRM_PILOT_SETUP.md`.
- No provider/model pricing has been verified against an authoritative
  source, so `estimatedCostUsd` is always `null` in this build.
- No live human review has been performed in this session — the
  export/import/triage machinery is built and tested with synthetic data
  only.
- A single in-flight Playwright action already started (e.g. one
  `page.click()`) still runs to its own internal timeout when Stop is
  pressed mid-action — no new action, request, or repair starts after
  Stop, but the one already in flight is not instantly severed. This is
  the bounded-cleanup behavior the original spec anticipated, not instant
  interruption. **As of 2026-09-15 this has a concrete, tested bound:
  ≤15s during login (one login step's own timeout), ≤5s during
  replay/exploration (`LOCATOR_TIMEOUT_MS`) — see the corrected §8a
  section above.**

## Incidents disclosed during this phase (not swept under the rug)

- **An accidental live provider call** (original pass, kept here
  unmodified per instruction). While manually verifying Milestone D1's
  changes, `npm run experiment:phase3 -- capture` was run without
  `--config qa.config.mock.yaml`. The default config (`qa.config.yaml`)
  is configured for a live Explabs provider, and an untracked `.env` file
  supplies a real credential `dotenv/config` loads automatically. This
  made one unauthorized live API call. The observed behavior (one page
  explored, zero findings, the run ending quickly) is consistent with
  the HTTP 429 rate-limiting already recorded in this project's Phase 2
  environment notes, so real cost was very likely not incurred, but this
  cannot be fully confirmed after the fact. The underlying fix was
  confirmed via the automated test suite instead of repeating the manual
  invocation. This continuation's own live-gating fix (§3) is a direct,
  structural response to this incident: every entry point that can make
  a live call now requires an explicit `--live` flag, not just a correct
  `--config` argument.
- **A related regression found and fixed** (original pass): the
  `onProgress` type change left three CLI entry points logging the raw
  event object instead of its `.detail` string; fixed in all three.
- **A genuine terminal-progress-event bug, found this continuation via
  real-browser testing** (not by any automated test — see §5 above for
  the full description): fixed, and a regression test now asserts the
  SSE stream's last delivered event is always a terminal phase.

## Final verification (raw results, 2026-09-11 continuation)

- `npm run typecheck`: clean.
- `npm run build`: clean.
- `npx vitest run` (full suite, run in isolation — not concurrently with
  any other process binding a fixture-server port): **60 files / 470
  tests pass**.
- `npm run qa -- --config qa.config.mock.yaml`: 9 findings, precision
  0.667/recall 1.0 (detection), precision 0.75/recall 1.0 (final report)
  — identical to the pre-continuation baseline, confirming none of this
  pass's fixes altered fixture behavior (every fixture-path check is
  exempted by construction).
- `npm run benchmark -- --config qa.config.mock.yaml`: precision 0.667 /
  recall 1.000 / F1 0.800 — identical to the known baseline.
- `npm run experiment:phase3 -- --config qa.config.mock.yaml` (capture):
  same four-condition numbers as the known baseline
  (critic_off_grouping_off through critic_on_grouping_on).
- `npm run challenge-corpus:validate`: 20/20 cases valid.
- `npm run doctor -- --profile fixture`: **READY** — "Target reachable"
  now correctly shows `~` (managed), not a false `✗`.
- `npm run doctor -- --profile orangehrm`: NOT READY — "Target
  reachable" correctly shows a genuine `✗` (the target really is
  unreachable), distinct from the fixture's managed status.
- UI: manually verified live in a real browser this continuation (see
  §5 above) — provider identity in the profile list, the `~` managed
  preflight status, a full demo run with live progress, active-run
  recovery after a mid-run page refresh, correct terminal completion,
  and evidence links resolving through the artifact route.
- `git status`/`git log -5`: HEAD is `17b6aa9` ("Update AutoQA project")
  -- the user's own manual commit of the original Phase 4 pass, made
  between sessions, exactly as authorized ("I will commit manually").
  This continuation's changes sit entirely as uncommitted working-tree
  modifications on top of that commit (confirmed via `git status`: every
  file this continuation touched shows as `modified`/untracked, nothing
  staged); no push, PR, or other GitHub write occurred at any point in
  this continuation.

## Final verification (raw results, 2026-09-14 addendum)

- `npm run typecheck`: clean.
- `npm run build`: clean.
- `npx vitest run` (full suite, run in isolation — not concurrently with
  any other process binding a fixture-server port): **62 files / 513
  tests pass** (up from 60/470 at the 2026-09-11 continuation's own
  verification — the addendum's new regression tests, including the
  redirect-hit-counting tests that are this pass's cited evidence for
  §1a, not merely "tests pass").
- `npm run qa -- --config qa.config.mock.yaml`: 9 findings, precision
  0.67/recall 1.00 (detection), precision 0.75/recall 1.00 (final report)
  — identical to every prior baseline, confirming none of this addendum's
  fixes altered fixture behavior.
- `npm run doctor -- --profile fixture`: **READY** — "Target reachable"
  still correctly shows `~` (managed), and the new path-scope check (§6a)
  does not affect this profile since its `allowedPathPrefixes` already
  covers the whole target.
- `git status`: every file this addendum touched shows as
  `modified`/untracked; nothing staged, committed, or pushed. No live or
  paid provider request was made — mock providers and fake test
  credentials throughout, per instruction.

## Final verification (raw results, 2026-09-15 pass)

- `npm run typecheck`: clean.
- `npm run build`: clean.
- `npx vitest run` (full suite, run in isolation — not concurrently with
  any other process binding a fixture-server port): **64 files / 542
  tests pass** (up from 62/513 at the 2026-09-14 addendum's own
  verification — this pass's new regression tests, including the
  operational-navigation/replay redaction-boundary tests, the two
  wall-clock cancellation tests, the full-stack `orangehrm.json`
  login-policy tests, the profile-editor e2e tests, the declared-workflow
  manifest tests, and the `ProfileStore.list()` sibling-manifest
  regression test).
- `npm run qa -- --config qa.config.mock.yaml`: 9 findings validated (0
  rejected, 0 needs-human), precision 0.67/recall 1.00 (detection),
  precision 0.75/recall 1.00 (final report) — identical to every prior
  baseline, confirming none of this pass's fixes altered fixture
  behavior. Run ID `RUN-20260915-075520200Z-ab38` (note the new
  collision-resistant random suffix).
- `npm run doctor -- --profile fixture`: **READY** — all six checks pass
  (schema, Chromium launch, navigation-scope consistency, `~` managed
  target-reachable, no-auth, provider resolution).
- `npm run doctor -- --profile orangehrm`: **NOT READY** — schema,
  Chromium launch, navigation-scope, login-configuration, and provider
  checks all pass; `✗ Target reachable: Could not reach
  http://localhost:8080/web/index.php/dashboard/index: fetch failed` —
  the correct, honest result given the environment blocker documented
  above, not a bug.
- Real-browser verification (Claude Browser MCP, `http://localhost:4180`):
  created a new profile via the new "1b. Create / edit project" UI,
  confirmed a deliberately-incomplete profile was rejected with an inline
  `navigation.allowedOrigins must contain at least one origin` error
  (not a crash or silent failure), saved a valid profile, confirmed it
  appeared in the profile dropdown, edited its name, confirmed the edit
  persisted via `GET /api/profiles/:id`, and ran "Check setup" against it
  end-to-end to `Overall: READY`. This exercise surfaced the
  `ProfileStore.list()` bug described above; found, fixed, covered by a
  new regression test, and re-verified live (the profile list populated
  correctly on reload) before the test profile file was deleted as
  verification-only scratch, not a deliverable.
- No live or paid provider request was made anywhere in this pass — mock
  providers and fake test credentials throughout, per instruction.
  `git status` confirms HEAD is still `17b6aa9`; every file this pass
  touched shows as `modified`/untracked, nothing staged, nothing
  committed, nothing pushed — left entirely for the user's own review and
  manual commit.

## Final verification (raw results, 2026-09-16 pass)

- `npm run typecheck`: clean.
- `npm run build`: clean.
- `npx vitest run` (full suite, run in isolation — not concurrently with
  any other process binding a port): **66 files / 550 tests pass** (up
  from 64/542 at the 2026-09-15 pass's own count — this pass added
  `tests/actions-cancellation.test.ts` (5 tests), `tests/run-pipeline-
  port-isolation.test.ts` (1 test), and new/strengthened tests in
  `tests/auth/session-bootstrap.test.ts`, `tests/validator.test.ts`, and
  `tests/run-manager.test.ts`).
- `npm run qa -- --config qa.config.mock.yaml`: 9 findings, precision
  0.67/recall 1.00 (detection), precision 0.75/recall 1.00 (final report)
  — identical to every prior baseline. `Target: http://localhost:53823/`
  — the YAML's own literal `4173` was dynamically overridden, confirming
  the port-isolation fix works on the real production CLI path, not only
  in tests.
- `npm run doctor -- --profile fixture`: **READY** — all checks pass,
  unchanged.
- `npm run doctor -- --profile orangehrm` was deliberately **not run**
  this pass — it's deferred (see Milestone C above); re-running it would
  add nothing new and risks reading as renewed pilot investigation, which
  was explicitly out of scope.
- Real-browser verification (Claude Browser MCP, `http://localhost:4180`):
  the full ordinary-user journey against both the `fixture` profile and a
  newly-created `owned-sandbox` profile pointed at a disposable local
  Node HTTP server — profile create/edit with explicit scope, Check
  setup (including a genuine reachability probe against the real target),
  a mock run actually exploring that real target, active-run recovery on
  refresh, Stop halting in ~2s with 5 findings-so-far preserved and the
  run correctly labeled "cancelled," and each finding's inline screenshot
  confirmed resolving via a direct HTTP request (`image/png`, 12.7KB).
  This exercise found and fixed one real usability gap (the unbounded
  prior-runs list) — see above. The verification-only profile and its
  disposable local server were both cleaned up afterward; `profiles/
  fixture.json`, `profiles/orangehrm.json`, and `profiles/
  orangehrm.workflows.json` are the only profile files remaining.
- `git status`: HEAD unchanged at `17b6aa9`; every file this pass touched
  shows as `modified`/untracked, nothing staged, nothing committed,
  nothing pushed. `profiles/orangehrm.json`, `profiles/
  orangehrm.workflows.json`, and `docs/ORANGEHRM_PILOT_SETUP.md` carry
  only their pre-existing (2026-09-15) modifications — confirmed via
  `git diff` that this pass added nothing to them, per the explicit
  instruction to defer OrangeHRM entirely.
- No live or paid provider request was made anywhere in this pass — mock
  providers and fake test credentials throughout (a disposable local HTTP
  server with no real data, `owned-sandbox`/`self-hosted-real-app`
  environment kinds used correctly rather than mislabeling real-target
  tests as `local-fixture`).

## Confirmation

No `git push`, no PR, no GitHub write of any kind occurred during the
original Phase 4 pass, the 2026-09-11 continuation, the 2026-09-14
addendum, the 2026-09-15 pass, or the 2026-09-16 pass. All commits, at
whatever granularity chosen, are the user's own. No live or paid provider
request was made in any pass; mock providers and fake credentials were
used throughout. The 2026-09-16 pass touched no OrangeHRM-related file.
