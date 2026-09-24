# AutoQA — Progress

## Run-scoped authenticated checks + read-only workflow discovery — 2026-09-24

Baseline verified at a392a1b (clean tree; 690/82 claim, request-scope.ts hard reject, post-browser checks against a restarted fixture, empty Ajeer manifest all confirmed). Repo hygiene, left as is by user decision: eb31014 tracked `.playwright-mcp/` (228 snapshots, a receipt PDF, a transactions CSV), the `kowshi1119` gitlink and `build_report*.js` in the public repo; this phase stages files explicitly and adds nothing further.

**Transport comparison** (playwright.dev/docs/api/class-apirequestcontext, accessed 2026-09-24): `context.request` shares the run's cookie jar but stores whole responses in memory (no streaming byte cap) and documents no route-interception guarantee; `page.evaluate(fetch)` follows redirects inside the page and cannot be capped cleanly. Chosen: per-request `context.cookies([url])` read in memory from the run's live context, sent through the existing streaming `fireCheckRequest()` after every scope/method/budget gate. Limitation: token/storage sessions are not transferable (explicitly unsupported).

**Implemented:** `onSessionReady` hook in `runPipeline` (after workflows, before the browser/fixture close; skipped for auth-only/failed/cancelled runs); session-aware requester (`request-scope.ts`: opt-in `apiChecks.useRunSession`, no-cookie → nothing sent, 401/440/redirect-to-login → session expired, later checks not sent); ledger `session` field; checks moved into the run (the separate post-run fixture server is gone); declared API mismatches → `needs_human` ("assertion mismatch", not a defect); synthetic `fixture/auth-server.ts` + `npm run fixture:auth`; `profiles/auth-demo*.json`; workflow discovery (`src/pilot/workflow-discovery.ts`, routes `POST /api/profiles/:id/workflow-discovery` and `/workflows`, shared discovery lock, `saveWorkflowManifest()`); UI section 1d and truthful labels. Found and fixed during testing: declared runs never offered a workflow whose start page differed from where the previous one ended (now a budget-counted setup navigation to the declared start), with a misleading "Deterministic mock selection." block reason.

**Live UI evidence (synthetic auth fixture, mock providers, 0 external model requests):**
- Authentication only: `RUN-20260924-054835775Z-ccfa` — succeeded, 4 actions, 0 HTTP check requests.
- Discovery (UI 1d): drafts NAV-STATEMENTS / NAV-PROFILE / NAV-HELP; skipped Delete account, Send money, Log out (state-changing wording, never opened), Partner offers (off origin), Activity (no heading). Save with nothing ticked refused; all three saved.
- Full run: `RUN-20260924-054927229Z-008a` — auth succeeded; 3/3 workflows completed with URL + heading assertions; checks AUTH-ME / AUTH-STATEMENTS / AUTH-REDIRECT-OFFSITE passed with the run session, AUTH-TRANSFER-BLOCKED not sent, AUTH-HEADERS needs review; 10 browser actions, 4 HTTP check requests, 4 mock decisions.
- Stop during a workflow: `RUN-20260924-055018618Z-4b12` — Stopped ~2.4 s after the click, workflows recorded as not executed, 0 check requests, Start usable.
- Fresh repeat of NAV-STATEMENTS: `RUN-20260924-055033629Z-4627` — completed again; same check outcomes.
- None of these run directories contains a session cookie, a cookie header or the password.
- No-key Demo with relocated checks: `RUN-20260924-054642683Z-d430` (checks-demo) — 7 ledger entries, 10/10 requests, cross-account result correctly "inconclusive" (fixture returns the caller's own record).
- Canonical fixture (`npm run qa -- --config qa.config.mock.yaml`): `RUN-20260924-055132354Z-6c27` — 74 actions, 38 mock decisions, 34.7 s; detection P 0.667 / R 1.000 / F1 0.800 (6 TP, 3 FP, 0 FN); final disposition 0.750 / 1.000 / 0.857; grouped 1.000 / 1.000 / 1.000. Labels, matcher and grouping unchanged.

**Disclosure:** while scripting the UI demo, a page reload had not finished when my next script ran, so the page defaulted to the `ajeer` profile and an Authentication only run started against the Ajeer sandbox with the *synthetic* `demo-a` account: `RUN-20260924-054743933Z-635b`, 4 login actions, sign-in not accepted, run cancelled, nothing captured. No real credential was used and nothing was changed. Subsequent scripts verified the selected profile immediately before Start.

**New tests:** `tests/checks/run-session-checks.test.ts` (10: authenticated read; no cookie → nothing sent; rejected and redirect-to-login sessions; expiry during confirmation; off-origin redirect with 0 offsite hits; unauthorized mutation with 0 target hits; oversize; Stop mid-body; two independent sessions; no session value in any evidence file), `tests/run-manager/authenticated-checks.test.ts` (4, real Chromium: login → workflow → run-session checks; auth-only stays auth-only; no opt-in → unsupported; Stop during a streaming check → one "stopped" terminal event, usage and report saved), `tests/pilot/workflow-discovery.test.ts` (4: read-only candidates only; unverified/rejected sign-in; tampered drafts rejected; saved workflows complete across start pages and a stale heading yields `failed`), plus a bounds test for "opt-in but no session".

**Final verification (frozen source, `npm run verify:local`, 2026-09-24):** typecheck and build passed; **709 tests / 85 files passed, zero failures (362.48 s, two workers)** — the 690/82 baseline plus the 19 new tests in 3 new files; challenge corpus 20 cases VALID. No source was edited during the run. Earlier focused runs during development had two expected failures from intended behavior changes (the "unsupported" wording and API mismatch disposition) and one from the start-page gap above; all were resolved before freezing. None of this is real-model evaluation or Ajeer acceptance.

## Final audit verification — recorded 2026-09-24

The frozen-source no-key verification finished on 2026-09-23: typecheck/build passed; **690 tests / 82 files passed, zero failures (348.22 seconds)**; all 20 challenge-corpus cases validated. The earlier mixed-revision run had 689 passing/1 failing test (319.15s), because the authenticated-profile guard and its test were edited during that run. That failure is preserved as a failed run, not retrospectively green. Final focused verification passed 47 tests/7 files before the frozen full run.

Final UI checks demo: **RUN-20260923-112925129Z-8f5e**, seven ledger entries, ten HTTP requests, ten browser actions, six mock decisions, zero external model requests. Final full fixture: **RUN-20260923-112936221Z-b3d2**, completed, 74 actions/38 mock decisions; separate Stop: **RUN-20260923-113014864Z-6395**, cancelled after 3 actions/2 decisions, Start usable. Evidence links and mobile layout checks passed. Canonical fixture precision 0.667/recall 1.0/F1 0.8; four frozen mock decision cases passed. Corpus validation and mock behavior are not real-model evaluation.

On resumption, the implementation was already included in eb31014 and HEAD was c52c5ea; fetch confirmed main and origin/main matched with a clean working tree. Those intervening commits were preserved. Next phase: guarded in-memory authenticated HTTP checks and observed read-only workflows. Ajeer authentication is evidenced, but its workflow manifest remains empty; no credential or stored session is reused.

## API/security audit continuation — 2026-09-23

Resumed at 3579f6d and audited the existing implementation. New regression baseline: 8 failed/1 passed in tests/checks/bounds.test.ts before fixes. Fixed streaming response limits, canonical request scope, shared request/duration/finding budgets, failed/mismatched confirmations, automatic mutation replay, contextual security classification, cookie parsing and structured secret redaction. Added delayed-body discovery/run exclusion coverage and real UI tests for completion/evidence and Stop during an in-flight response.

The shipped checks demo completed as RUN-20260923-112211067Z-e5bc: seven ledger entries, ten HTTP requests, ten browser actions, six mock decisions, zero external model requests. Evidence was accessible/parseable and desktop/mobile results visually reviewed. Its old cross-account “confirmed” outcome was withdrawn because the fixture returned A-owned content, not B-owned data. Raw 0.667/final 0.75/grouped 1.0 fixture precision are distinct unchanged measurements.

Existing Ajeer auth smoke RUN-20260923-075117245Z-df87 was independently verified as success/four actions; no new Ajeer login or workflow was attempted. Workflow manifest remains empty. Authenticated standalone API checks and real cross-account probing are unsupported. Research decisions and limits are in README.md. Final verification results follow after the current full suite completes.

## Current checkpoint — 2026-09-23 (API/security checks + two reliability fixes)

Closed two demonstrated reliability gaps: a TOCTOU race that let a run and an auth-discovery session start concurrently (`src/run-manager.ts`, `src/server/app.ts`; regression: `tests/run-manager/toctou.test.ts`), and a redaction-breadth gap in `src/redact.ts` plus a new JSON-tree-aware `redactStructuredEvidence()` (`src/checks/redact-structured.ts`) needed because a flat regex cannot reach a value behind a JSON-quoted key like `{"Set-Cookie": "..."}`.

Traced the canonical fixture's 3 detection-level false positives (not a code defect — see README's "Three-tier detection metrics"); added a regression assertion in `tests/reporting/assemble.test.ts` locking `grouping.json`'s own benchmark at precision/recall/F1 = 1.0/1.0/1.0.

Built two new bounded, opt-in vertical slices against synthetic local fixtures: **API testing** (`src/checks/run-api-checks.ts` — declared HTTP requests with deterministic status/content-type/required-field/shape/invariant assertions, mutating requests denied by default unless explicitly allowlisted) and **security testing** (`src/checks/run-security-checks.ts` — cookie attributes, security response headers, response-body secret leakage, and a session-boundary check using two seeded local demo accounts). Every declared check always gets a `check-results.json` ledger entry (ran/blocked/classification), whether or not it produced a `Finding`; a missing header is `needs_review`, never auto-`confirmed`. New UI panel ("API and security checks") in the control panel, additive to the existing results view.

Two real bugs found and fixed only by actually running this live through the UI (not just unit tests): (1) `ProfileStore.list()` didn't exclude the new `<id>.checks.json` manifest file, so it tried to load it as a profile and 500'd the entire profile list — same bug class as the 2026-09-15 `.workflows.json` fix, reintroduced by the new manifest type (regression added to `tests/profiles/store.test.ts`); (2) for a `local-fixture` profile, `runPipeline()` already closes its own fixture-server instance before returning, so the checks phase needs (and now starts/stops) its own separate instance rather than reusing the now-dead origin.

**Live evidence, this session, via the real UI** — profile `checks-demo` (`profiles/checks-demo.json` + `profiles/checks-demo.checks.json`, both new tracked/shipped defaults), Demo mode, run `RUN-20260923-104736271Z-588e`: `API-USERS-OK` passed; `API-USERS-MISSING` produced `FINDING-002` (confirmed, `report`) from a genuinely wrong declared expectation (404 vs. expected 200); `API-DELETE-BLOCKED` correctly blocked with reason (`... is a mutating request not present in apiChecks.allowedMutatingEndpoints.`); `SEC-COOKIE` produced `FINDING-003` (`needs_review`, missing HttpOnly/Secure/SameSite on a deliberately weak fixture cookie); `SEC-HEADERS` produced `FINDING-004` (`needs_review`, missing standard security headers); `SEC-LEAK` passed; `SEC-SESSION-BOUNDARY` produced `FINDING-005` (`confirmed`, `report` — demo-a's session read demo-b's resource on the deliberately vulnerable fixture route). Confirmed by reading the raw persisted evidence file directly (not just the UI's rendering): `findings/FINDING-003/response.json`'s `set-cookie` header reads `"<REDACTED>"`, and `findings/FINDING-005/response.json`'s `secretNote` field reads `"<REDACTED>"` — the structured, key-name-aware redaction pass genuinely runs, not merely unit-tested in isolation.

**Ajeer**: found (not produced this session) `runs/RUN-20260923-075117245Z-df87/authentication.json` — `status: "success"`, `authenticatedUrl: "https://portal.sandbox.ajeer.money/home"`, via a real "Authentication only" run through AutoQA's normal guarded path (`stopReason: "AUTHENTICATION_ONLY: verified session"`). The user completed the Discover flow and the follow-up authentication-only run themselves since the last checkpoint — the deadlock PHASE6_ACCEPTANCE.md documents is genuinely closed. `profiles/ajeer.workflows.json` is still empty (`pages:[],workflows:[]`); authenticated workflow discovery/declaration has not happened yet — the next actual step for Ajeer acceptance, not attempted this pass (out of this pass's stated scope).

Full verification: `npm run typecheck` and `npm run build` clean. Full `npx vitest run` (fresh, isolated, after all changes above): **80 files / 667 tests pass, zero failures** (245.06s) — up from the prior checkpoint's 642/76 by exactly the 25 new tests added this pass (`tests/run-manager/toctou.test.ts` ×2, `tests/checks/redact-structured.test.ts` ×5, `tests/checks/run-api-checks.test.ts` ×6, `tests/checks/run-security-checks.test.ts` ×8, plus 3 new cases in `tests/security/redacted-json.test.ts` and 1 new regression test in `tests/profiles/store.test.ts`; `tests/reporting/assemble.test.ts` gained new assertions in its existing test, not a new test case).

## Checkpoint — 2026-09-23 (auth-discovery finalization)

Completed bounded/cancellable authentication discovery, verified accessible signals, exact route suggestions, readiness guidance, report-completion synchronization, and token-URL JSON redaction fixes. Preserved earlier deterministic cancellation coverage. Added no-key verification and a repeatable actual fixture UI acceptance script. History/results now identify project/run/environment.

Full verification passed typecheck/build, 642 tests/76 files (371.20s), and 20-case corpus validation. Final UI/strict-origin targeted suite passed 11 tests/3 files. Actual fixture completion RUN-20260923-053522611Z-68e9: 74 actions/38 mock decisions. Stop RUN-20260923-053605943Z-cda9: cancelled after 3 actions/2 decisions, Start usable. Evidence links and desktop/mobile layout passed. Canonical fixture precision 0.667, recall 1.0, F1 0.8; four mock decision cases passed. No real model inference or download.

Ajeer remains pending local credential entry, normal-run successful authentication and observed read-only workflows. Saved checks alone are not acceptance. Private profiles, raw runs, unrelated staged scratch/nested folders and the pre-existing AJEER_PILOT_REPORT.md deletion are excluded from the selected commit. See PHASE6_ACCEPTANCE.md for current evidence and historical failure distinctions.

Phase 1 is COMPLETE. Phase 2 is COMPLETE. Phase 3 is COMPLETE. Phase 4 is
COMPLETE for every requirement that does not require a reachable
OrangeHRM instance; the real-application pilot run itself (Milestone C)
is **deferred by explicit user instruction as of 2026-09-16** (an
environment blocker — Docker/PHP/MySQL absent — was also confirmed as
recently as 2026-09-15, but the current reason it isn't attempted is the
user's own scope decision, not only the environment) — see
`PHASE4_FINAL_ACCEPTANCE.md` for the exact acceptance checklist and
status. This file is kept for historical/resumability reference; see
README.md for the actual system documentation.

## Phase 4 — Easy Local Use and a Real-Application Pilot (in progress)

Purpose: usability and one real-app pilot, not more research
infrastructure. Phase 3's 298/298-tests / 1.0-precision-recall-F1 numbers
are a small deterministic benchmark result on a 6-defect fixture, not
evidence of real-world accuracy — they prove the pipeline is internally
consistent, not that a person can operate it or that it finds anything on
a real application. Commits in this phase are made manually by the user,
not by me — I implement and verify (typecheck/test/build) at each
checkpoint and stop for review rather than committing.

### Confirmed baseline before any implementation began

- **Test discovery bug, confirmed and reproduced live**: `npm test` was
  collecting 83 files / 601 tests instead of the expected ~41 files / 298
  tests, with a hard failure `EADDRINUSE: ::1:4196` in
  `tests/validator.test.ts`'s `beforeAll` (10s hook timeout). Root cause:
  `vitest.config.ts` had no explicit `include`/`exclude`, and
  `tsconfig.json` intentionally compiles `tests/**/*.ts` into
  `dist/tests/**/*.js` (tsc needs to typecheck tests too — a legitimate,
  unrelated convention). Once `dist/` exists on disk, Vitest's own default
  glob decides whether the compiled copies get picked up.
- **Vitest 2→4 relatedness — investigated, not left ambiguous.** Fetched
  the actual `defaultExclude` array from both installed/published
  packages: **Vitest 2.1.4's `defaultExclude` included `"**/dist/**"`**
  (`["**/node_modules/**", "**/dist/**", "**/cypress/**",
  "**/.{idea,git,cache,output,temp}/**", "**/{karma,rollup,...}.config.*"]`,
  fetched from `unpkg.com/vitest@2.1.4/dist/config.js`); **Vitest
  4.1.11's is only `["**/node_modules/**", "**/.git/**"]`** (read directly
  from this repo's installed `node_modules/vitest/dist/chunks/
  defaults.*.js`). **Conclusion: the uncommitted `vitest ^2.1.4` →
  `^4.1.11` bump in package.json is the proximate cause** — under v2,
  `dist/tests/**` would have been excluded by default even with today's
  unscoped `vitest.config.ts`, so this exact collision would not have
  manifested. The contributing latent factor is that `vitest.config.ts`
  never set its own explicit scoping and instead relied entirely on
  whichever exclusions a given Vitest version happened to ship with — a
  fragile position regardless of this specific version bump. The bump
  itself is kept (not reverted, per the spec); `vitest.config.ts` now sets
  `include`/`exclude` explicitly so future default changes can't
  reintroduce this class of bug.
- **Hardcoded-port sweep, confirmed complete**: exactly two files bind a
  real socket anywhere in `tests/`: `tests/validator.test.ts` (was `const
  PORT = 4196`) and `tests/safety/navigation-guard.test.ts` (was `const
  PORT = 4199`). No other `.listen(`/`createServer` call exists elsewhere
  in `tests/`. Both fixed to OS-assigned ports (`.listen(0, "localhost",
  ...)` + `(server.address() as AddressInfo).port`), removing the
  possibility of collision entirely rather than picking new literals.
- **Docker/OrangeHRM feasibility — checked before any Milestone A/B work,
  as the very first investigative action of this phase**: `docker`,
  `docker-compose`, and `docker compose` all exit 127 in this environment
  (not installed, not just stopped). Neither `orangehrm/orangehrm` nor
  `orangehrm/orangehrm-os-dev-environment` offers a single pinned
  one-command quick-start even where Docker is available. **Milestone C's
  live-pilot acceptance is marked PENDING from the start of this plan, not
  discovered late; Milestones A, B, and D proceed independently.**

### Fix verification (Milestone 0)

- `npm test` (dist/ present from a stale prior build): **41 files / 298
  tests passing**.
- `npm run build && npm test` (fresh build): **41 files / 298 tests
  passing**, identical — confirms discovery is fixed both before and
  after a build, not just incidentally at this moment.
- `npm run typecheck`: clean.

### Phase 4 milestone checklist (dependency order; updated as work lands)

- [x] Milestone 0 — Baseline repair (vitest discovery scoping, both
      hardcoded ports → ephemeral, Vitest-relatedness conclusion recorded
      above, this checklist itself)
- [x] Milestone A1 — Project profiles + `npm run doctor` preflight. New
      `src/profiles/` (`schema.ts` — additive `ProjectProfile` Zod schema,
      never a replacement for `configSchema`; `store.ts` — JSON-file
      load/save/list; `to-app-config.ts` — projects a profile into a full,
      existing-shape `AppConfig` so every downstream module is unchanged).
      Extracted `modelsSchema`/`originSchema` and exported
      `elementTargetSchema` (`src/actions.ts`) from their previous
      module-private definitions so profiles reuse the exact same
      provider-config and locator shapes the rest of the codebase already
      validates against, rather than inventing a second schema language.
      Two shipped profiles: `profiles/fixture.json` (wraps the existing
      local fixture, `environmentKind:"local-fixture"`) and
      `profiles/orangehrm.json` (`environmentKind:"self-hosted-real-app"`,
      form-login auth block using publicly-documented OrangeHRM locators —
      target URL/port are placeholders pending Milestone C's actual
      reachable instance). New `src/preflight/doctor.ts`
      (`runPreflight()` — 6 independently timeboxed, target-scoped checks:
      profile schema, Chromium launchable, target reachable, navigation
      scope consistency, login configuration, provider configuration) +
      `src/preflight/doctor-cli.ts` (`npm run doctor -- --profile <id>`).
      Provider check deliberately reports `"configured-but-unverified"`
      rather than a fabricated `"verified"` state: neither
      `ExplorerProvider` nor `CriticProvider` exposes a cheap ping
      primitive, and doctor must never make a paid call by default — a
      disclosed, honest scope decision rather than a stubbed-out claim.
      Manually verified end-to-end: `npm run doctor -- --profile fixture`
      and `-- --profile orangehrm` both correctly report `NOT READY` with
      a named `target-reachable` failure (neither target is running),
      never opening an exploration run or starting the fixture server as
      a side effect. 313/313 tests pass (+15: 9 schema/to-app-config, 6
      doctor), stable both before and after `npm run build`, typecheck
      clean.
- [ ] Milestone A2 — Action-level safety for real targets
- [x] Milestone A2 — Action-level safety for real targets. New
      `src/safety/action-policy.ts` (`ActionPolicy.classifyAction()` /
      `.classifyResourceRequest()`) — exempt entirely for
      `environmentKind:"local-fixture"` (the fixture's full Phase 1-3
      heuristic set is unchanged). Rather than editing nine separate
      heuristic files (H01-H09, which all share
      `buildFillAndMaybeSubmit`'s unconditional auto-submit), the policy
      intercepts the one thing that actually mutates state: a click or
      Enter-keypress resolved LIVE from the DOM (new
      `resolveFormContext()` in `src/actions.ts`, never inferred from a
      button's label) to be a form submit. Denied unless the form's exact
      `method + pathname` is on the profile's new
      `resources.allowedFormSubmitEndpoints` allowlist — HTTP method alone
      is deliberately never the safety boundary in either direction (a GET
      search form still needs explicit allowlisting, not just POST
      mutations). `executeAction()` (`src/actions.ts`) gained an optional
      `policy` param, checked before click/press execute; a denial returns
      `{outcome:"blocked", reason:"ACTION_POLICY_DENIED: ..."}` without
      touching the page. `installRouteGuard()`
      (`src/safety/navigation-guard.ts`) gained an optional
      `resourcePolicy` callback reusing the same allowlist as
      network-layer defense-in-depth, catching a state-changing XHR/fetch
      that bypasses click-based detection entirely (e.g. a JS handler
      firing `fetch(...,{method:"POST"})` directly). `SafetyEvent`
      (`src/types.ts`) extended to a discriminated union with a new
      `ACTION_POLICY_DENIED` code, giving every denial an audit record.
      **Recheck at execution AND during Validator replay**: `policy` is
      threaded through `OrchestratorDeps`/`ValidatorDeps`/`PipelineOptions`
      (all optional, absent for a legacy direct-YAML CLI run — zero
      behavior change confirmed by the full suite staying green
      throughout); `Validator.validate()` now checks each replayed step's
      own outcome and, on a block, skips oracle evaluation entirely for
      that attempt (new `ValidationAttemptResult.toolingBlocked` field) —
      a finding recorded before a profile's scope was tightened can never
      silently "reproduce" past the new denial, and a broken/blocked
      replay step is never scored as either a confirmed or disproven
      defect. Live orchestrator path needed no additional change beyond
      `executeAction`'s own denial: `Orchestrator.execute()` already
      transitions straight to `CONTINUE` on any non-success action
      outcome, skipping `OBSERVE`/`EVALUATE`/`VALIDATE` — so a denied
      action already produced zero findings by construction once
      `executeAction` itself denies it. New
      `tests/safety/action-policy.test.ts` (10 tests, real Chromium):
      classification unit tests (fixture-exempt, denied-by-default,
      allowed-once-allowlisted, non-submit click ignored,
      Enter-in-form-field denied); end-to-end `executeAction` tests
      (H01-style fill+submit sequence blocked at the click step with the
      mutate form provably never submitted client-side; an approved
      search submit actually fires; a denial emits exactly one
      `ACTION_POLICY_DENIED` safety event); a `Validator.validate()` test
      proving replay re-applies the policy (all 3 attempts
      `reproduced:false` + `toolingBlocked` set, finding status never
      `"validated"`); a request-level test proving an unapproved POST
      fetch is aborted even with no corresponding click at all. 323/323
      tests pass (+10), stable both before and after `npm run build`,
      typecheck clean.
- [x] Milestone A3 — Session bootstrap / authentication in exploration and
      validation. New `src/auth/session-bootstrap.ts`: `SessionBootstrap`
      interface, `NoAuthBootstrap`, and `FormLoginBootstrap` — generic,
      driven entirely by `profile.auth`'s locator fields (reuses
      `buildLocator()`, newly exported from `src/actions.ts`, for username/
      password/submit/signal targeting); no OrangeHRM-specific code exists
      outside profile data. Runs directly against `page`, never through
      `executeAction`/`QaAction`, so login steps are structurally excluded
      from `finding.steps`. `TransientCredentials` sourced from
      `QA_USERNAME`/`QA_PASSWORD` env vars (`resolveTransientCredentials()`)
      -- deliberately reuses the *existing* `QA_PASSWORD` mechanism
      `redactSecrets()`/`src/actions.ts#resolveFillValue()` already had
      from Phase 1, so the password is covered by the established
      redaction idiom with no new pattern needed.
      **`src/browser/browser.ts`**: `BrowserManager.newPageSession()`
      gains an optional `authOptions` param + private `ensureAuthenticated()`
      -- authenticates immediately after guard installation, before the
      caller ever navigates or evidence recorders see real traffic. A
      supplied `storageState` is re-verified on the fresh context
      (navigates to `target.url`, checks `authenticatedSignal` visibility
      -- protected-page-accessibility verification, never trusted blindly)
      before falling back to a bounded (`MAX_LOGIN_ATTEMPTS=2`) full
      re-login. New `AuthenticationError` (thrown on total failure) is
      caught by both `Orchestrator.initialize()` (→ explicit `AUTH_FAILED`
      stop reason, never a silent empty run) and `Validator.validate()`
      (→ that attempt is recorded `reproduced:false` +
      `toolingBlocked:"AUTH_FAILED: ..."`, reusing A2's tooling-outcome
      field, never misclassified as a disproven defect).
      `Orchestrator` captures `authStorageState` once right after its own
      successful login and threads it into the `Validator` it constructs,
      so replay reuses the session instead of a full re-login on every
      attempt (verified: 0 `establish()` calls when the carried-over state
      verifies; a real login exactly once per attempt when none is
      supplied). `sessionAuth`/`actionPolicy` both threaded as fully
      optional fields through `OrchestratorDeps`/`ValidatorDeps`/
      `PipelineOptions` -- absent for a legacy direct-YAML CLI run,
      confirmed zero behavior change by the full suite staying green
      throughout.
      **Secret hygiene**: `profileToAppConfig` (A1) already defaults
      `evidence.trace:false` for any non-fixture profile; confirmed here
      with an explicit test that a trace path is kept out of
      `EvidenceWriteResult.filenames` even if one were somehow produced.
      New `src/browser/observation.ts#maskPasswordFields()` injects a
      targeted, idempotent (marker-id-guarded) CSS rule blacking out every
      `input[type=password]` immediately before a screenshot capture when
      `observe(..., {maskSecrets:true})` -- wired on for authenticated
      (`auth.mode !== "none"`) profiles in `Validator`'s representative-
      evidence capture. Explicitly scoped as a screenshot-only mitigation,
      not a general redaction claim -- native trace/HAR capture can still
      carry cookies/session headers after login, which is exactly why
      trace stays off by default above rather than "fixed."
      **Disclosed scope decision**: full arbitrary-workflow-prerequisite
      replay (spec's "open-list-then-filter, not just goto(finding.url)")
      was NOT built this pass -- it would require extending `PageEdge`
      (`src/mapping/types.ts`) to carry a full replayable `QaAction`
      instead of today's `{type,label}` descriptor, plus a shortest-path
      search from the run's start page to the finding's page, which is a
      real, separate-sized feature better done with its own design/test
      pass rather than rushed in alongside authentication. What IS in
      place: `Validator.validate()` already does `goto(finding.url)`,
      which correctly restores any state the URL itself encodes (the
      common case for query-param-driven search/filter/pagination, which
      is how OrangeHRM's own list views work); state that lives only in
      prior client-side interaction is a disclosed limitation, and a
      resulting non-reproduction is scored as ordinary "not reproduced,"
      never fabricated as proof the issue doesn't exist -- consistent with
      how every other non-reproducing case already works.
      New tests: `tests/auth/session-bootstrap.test.ts` (6, real browser
      against a synthetic login page: success, wrong-credentials-never-
      throws, no-credentials-fails-explicitly, success-URL-but-missing-
      signal); `tests/validator-auth.test.ts` (3, real browser + real
      synthetic login/dashboard server: fresh authenticated session per
      attempt, storageState reuse with a real verified fallback path, and
      bounded-retry-never-loops on persistent auth failure); 4 new cases
      in `tests/security/secret-redaction.test.ts` (QA_PASSWORD value
      never in persisted evidence JSON, trace absent by default for a
      real-target profile, masking CSS actually injected before capture
      when requested, and confirmed absent when not). 336/336 tests pass
      (+13), stable both before and after `npm run build`, typecheck
      clean.
- [x] Milestone B — Local control panel. **Shared execution/report-
      assembly path extraction (the concrete fix for the architectural
      watch-item)**: new `src/reporting/assemble.ts#assembleReport()` is
      `src/index.ts#main()`'s previous inline lines ~106-238 (grouping →
      coverage/summary → ground-truth-gated benchmark/phase2/grouping-
      benchmark → final `QaReport` assembly → write), extracted verbatim
      as a pure function; `index.ts` now calls `runPipeline()` then
      `assembleReport()`, confirmed byte-for-byte behavior-preserving by
      re-running `npm run qa -- --config qa.config.mock.yaml` and getting
      the identical known numbers (precision 0.667/0.75, 9 validated
      findings) plus a dedicated `tests/reporting/assemble.test.ts`
      driving the real pipeline and asserting the same values through the
      extracted path. New `src/run-manager.ts#RunManager` is a thin
      cancellable wrapper around this exact `runPipeline()` +
      `assembleReport()` pair -- not a second, hand-rolled "start/track/
      stop a run" implementation; both the CLI and the UI ultimately call
      the same two functions, so they cannot drift apart from each other.
      Orchestrator FSM gained a real `CANCELLED` terminal state
      (`src/orchestrator/states.ts`, reachable from every non-terminal
      state alongside `FAILED`) and an `abortSignal` checked between FSM
      steps (`Orchestrator.run()`) and between Validator replay attempts
      (`Validator.validate()`) -- a cancelled run's `run-summary.json` gets
      `status:"cancelled"`, never `"completed"`, confirmed live via the
      browser (started a real run, clicked Stop, verified the on-disk
      summary). Progress reporting (`onProgress`) changed from a bare
      string to a structured `RunProgressEvent`
      (`{phase,detail,pagesVisited,actionsPerformed,remainingActions,
      remainingDurationMs,reportableCount,needsReviewCount}`, new
      `src/progress.ts`) -- no fake percent-complete against an unknown
      discovery denominator, only real counters; `phase` is a disclosed,
      deliberately coarse-grained mapping from FSM state (exploring/
      reproducing/completed/stopped/failed), not a 1:1 match to every
      named phase in the spec (signing-in/reviewing are folded into
      exploring's `.detail` text rather than the FSM growing dedicated
      states for them).
      New `src/server/` (plain `node:http`, no Express/Fastify -- the
      whole surface is a handful of JSON endpoints + one static page, not
      worth a framework dependency): `app.ts` (routing, binds `127.0.0.1`
      only), `security.ts` (per-process random CSRF token checked via
      header on every mutating request; Origin/Host validated against the
      server's own bound loopback address; no CORS headers ever set;
      `resolveArtifactPath()` resolves strictly through
      `runsRootDir/<runId>/...`, rejecting traversal and symlink escapes
      via `realpathSync` containment checks), `routes/{profiles,
      preflight,runs,artifacts}.ts`. Request bodies Zod-validated
      (`routes/runs.ts`'s `startRunSchema`). Artifacts served with an
      explicit allowlisted `Content-Type` + `X-Content-Type-Options:
      nosniff` -- never HTML-sniffable. Progress delivered via SSE
      (`GET /api/runs/:id/events`), with a polling fallback
      (`GET /api/runs/:id/status`) for reconnect-after-drop, never
      console-text-scraping. `npm run ui` (`src/server/app-cli.ts`, port
      4180) -- static assets under `src/server/public/` are copied to
      `dist/` by a small `scripts/copy-public-assets.mjs` step (tsc only
      compiles `.ts`).
      New `src/server/public/index.html`: vanilla HTML/JS (no build step,
      no framework), profile picker → "Check setup" (renders each named
      preflight check pass/fail/next-step) → conditional login section
      (shown only when the profile's `authMode !== "none"`, explicitly
      labeled "not saved") → Demo/Live mode selector (Live shows
      provider/model/limits text and echoes `confirmedLimits` back per
      D1's gating) → Start/Stop + live counters → bucketed results
      (Reportable/Needs Review/Suppressed/Not Reproduced, using the exact
      canonical/grouped-count logic `assembleReport()` computes) → prior-
      runs list. Every captured/served piece of text is set via
      `textContent`, never `innerHTML` -- confirmed by a security test
      that a `<script>` tag embedded in a served JSON artifact is
      delivered as inert `application/json`, never interpretable as HTML.
      `RunManager.listRuns()` also fixes a gap found while implementing
      it: a run directory with NO `run-summary.json` at all (the realistic
      "server died mid-run" case, since `assembleReport()` only ever
      writes a *terminal* status) was being silently skipped by a first
      draft of the reconciliation logic instead of surfacing as
      `"interrupted"`; fixed before writing tests, and confirmed live
      against this repo's own accumulated `runs/` directory (many
      pre-existing incomplete run directories from earlier phases now
      correctly show as "interrupted" instead of vanishing).
      **Cross-file test port collision found and fixed**: running the full
      suite revealed `tests/reporting/assemble.test.ts`,
      `tests/run-manager.test.ts`, and `tests/server/e2e-fixture.test.ts`
      all drive a real fixture server, and two of them both defaulted to
      port 4173 (matching `qa.config.mock.yaml`'s convention) -- passing
      individually but colliding under Vitest's parallel-file execution,
      the same class of bug Milestone 0 fixed for two other files. Since a
      single fixture-server port is baked into every profile/config that
      uses one (ephemeral-izing it end-to-end would need deeper
      `runPipeline()` plumbing this milestone didn't otherwise need),
      fixed by giving each of the two test-authored profiles its own
      distinct, documented, collision-free port (4183, 4193) rather than
      reintroducing the fragility Milestone 0 had just closed. Confirmed
      by running the full suite twice in a row after the fix.
      Manually verified end-to-end via the Browser tool against a real
      `npm run ui` process: profile picker/Check-setup render correctly
      with an honest NOT READY result; Start produces live SSE progress
      (phase/detail text + all six real counters updating); Stop actually
      halts a real in-progress run and the resulting `run-summary.json`
      correctly reads `status:"cancelled"`, `stopReason:"CANCELLED: stop
      requested by user"`.
      New tests: `tests/reporting/assemble.test.ts` (1, drives the real
      pipeline, byte-for-byte parity proof), `tests/run-manager.test.ts`
      (6: full fixture run → completed, second-start-while-active
      rejected, cancellation → cancelled-never-completed, stop-on-unknown-
      id → false, live-mode-requires-matching-confirmedLimits x2,
      interrupted-run-reconciliation), `tests/server/security.test.ts`
      (11: loopback bind, CSRF-token-embedded, missing-CSRF rejected,
      wrong-Origin rejected even with valid CSRF, no CORS headers ever,
      malformed body rejected, path-traversal rejected, unknown-run-id
      404, Content-Type/nosniff on a real artifact, preflight happy/
      unknown-profile paths), `tests/server/e2e-fixture.test.ts` (3: list
      profiles, full run-via-HTTP-API with canonical-count assertion,
      useful non-crashing setup error). 358/358 tests pass (+22), stable
      across two consecutive full-suite runs and both before/after
      `npm run build`, typecheck clean.
- [~] Milestone C — OrangeHRM real-application pilot. Adapter/profile/
      reporting machinery COMPLETE; **live-pilot acceptance PENDING** --
      confirmed at the start of this milestone that neither Docker nor a
      native PHP/MySQL install path is available in this environment (see
      `docs/ORANGEHRM_PILOT_SETUP.md` for the exact commands checked and
      the full setup/acceptance checklist). `profiles/orangehrm.json`
      (from A1) is the adapter -- pure profile data (locators, URLs,
      limits) consumed entirely through the generic `FormLoginBootstrap`/
      `ActionPolicy`/Planner machinery already built in Milestone A, no
      OrangeHRM-specific branching anywhere in the Planner/Validator/
      oracles. New `src/reporting/pilot-report.ts#buildPilotSummary()`:
      pilot-specific summary (target/pages/workflows/findings-by-bucket)
      that renders precision/recall/F1 as literal `"N/A"` with an
      explanatory reason (no independently labeled defect dataset exists
      for a real target, unlike the fixture's positive-control answer
      key) and a separately-named/denominated `humanAcceptance` field
      (`{status:"unavailable"}` by default -- never fabricates
      participation). Reuses the existing `heuristicsApplicable`/
      `heuristicsExecuted` coverage counters as "workflows" rather than
      inventing untracked ones. `tests/security/no-ground-truth-leak.test.ts`
      extended to cover this new file -- confirmed it never references the
      fixture's answer-key file in any form (a real bug caught while
      writing this: the file's own doc comments and one error-message
      string initially DID mention it by name/literal path, tripping the
      security test; rephrased to describe it structurally instead of
      naming it, then reconfirmed clean). New
      `tests/reporting/pilot-report.test.ts` (7 tests: N/A rendering,
      unavailable-by-default human acceptance, zero-findings-is-valid,
      disposition/status bucketing, coverage-counter reuse, source-level
      ground-truth-reference check). README's stale "TODO: Phase 4 --
      not started" section replaced with an accurate in-progress pointer
      to this file. 364/364 tests pass (+6: pilot-report), typecheck
      clean. **What remains genuinely blocked**: everything in
      `docs/ORANGEHRM_PILOT_SETUP.md`'s acceptance checklist that requires
      an actually-reachable instance -- doctor READY, locator verification
      against the real DOM, the full preflight-through-report-delivery
      demonstration, and a real-or-controlled-fault replay. Milestones A,
      B, and D proceed independently per the phase's own "external
      dependencies do not justify stopping all work" guidance.
- [x] Milestone D1 — Provider usage accounting + live-run budget gating.
      **Hidden-retry accounting**: all three provider clients (`AnthropicModelProvider`,
      `AnthropicCriticProvider`, the shared `ExplabsClient`) now construct
      their SDK client with `maxRetries: 0` -- both the Anthropic and
      OpenAI-compatible SDKs default to 2 hidden internal retries on
      429/5xx, which would have made every budget/usage counter in this
      codebase silently undercount real network attempts. AutoQA's own
      bounded budgets are now the single source of truth for request
      counting.
      **Timeout/budget parity fix (the confirmed gap)**:
      `src/experiments/conditions.ts#runCondition()` used to call
      `criticProvider.critique()` directly with no timeout and no request
      cap, unlike the live per-run path
      (`src/critic/critic-runner.ts#Critic.review()`). Sharing
      `buildCriticInput()`/`decideDisposition()` alone did not guarantee
      this, confirmed as a real, distinct gap. Fixed by exporting
      `withTimeout()` from `critic-runner.ts` and giving `runCondition()`
      its own `BudgetTracker` (scoped to one condition run, built from
      `conditionConfig.agent.*` exactly like `run-pipeline.ts` does) plus
      the same `canCallCritic()`/`isDurationExceeded()`/`recordCriticCall()`
      checks -- no call-site changes needed anywhere else since the
      budget is constructed internally. New
      `tests/experiments/conditions-budget.test.ts` proves both
      directions for real: a critic provider that never resolves is
      rejected via the timeout wrapper in under 5s (not hung), and a
      `maxCriticCalls:1` budget correctly caps a second finding's critic
      call as `BUDGET_EXHAUSTED` rather than silently uncapped.
      **New `src/models/usage-tracker.ts#UsageTracker`**: records every
      actual provider request attempt
      (`{provider,role,attemptNumber,requestStartedAt/EndedAt,latencyMs,
      outcome,tokenUsage}`) -- distinct from `BudgetTracker`'s own
      allow/deny counters, this records what actually happened to each
      call that was made. `tokenUsage` is `null` whenever a provider
      doesn't report it (the case for every provider in this build today),
      never fabricated as `0`; `summary()` only sums token usage across a
      role when *every* attempt in that role reported it, never partially
      summed and presented as complete. Wired into both
      `Explorer.decide()` and `Critic.review()` (both gained an optional
      `usageTracker` param, threaded through `OrchestratorDeps` →
      `Explorer`/`Critic` construction, and through `run-pipeline.ts` →
      `PipelineResult`, exactly mirroring how `actionPolicy`/`sessionAuth`
      were threaded in earlier milestones -- absent/no-op for any caller
      that doesn't pass one).
      **New `src/models/pricing.ts`**: `PRICING_TABLE` is deliberately
      empty -- no provider/model rate has been verified against an
      authoritative source in this build. `estimateCostUsd()`/
      `estimateRunCostUsd()` return `costUsd:null` with a specific
      disclosure reason whenever pricing or token usage is unknown for
      either role (never silently averaged from the known half), and
      `costUsd:0` only when zero requests were actually made. `RunSummary`
      and `QaReport` (`src/report.ts`/`src/reporting/qa-report.ts`) gained
      a `usage: {explorer, critic, estimatedCostUsd, costDisclosure}`
      block, computed in `assembleReport()`, replacing the old
      Phase-1-era `tokenUsage: null` placeholder field now that real
      request counts are actually measured. `buildReportMarkdown()` gained
      a "## Provider usage" section. Verified for real:
      `npm run qa -- --config qa.config.mock.yaml`'s `report.json` shows
      `usage.explorer.requests: 38` (matches the console's own "Model
      calls: 38") and `usage.critic.requests: 9` (matches "Findings
      suspected: 9" -- one critic call per validated finding), with
      `estimatedCostUsd: null` and an accurate disclosure naming the
      missing pricing metadata for both roles.
      **Live-run gating** was already built in Milestone B
      (`RunManager.startRun()`'s `mode:"live"` requiring `confirmedLimits`
      to deep-equal the profile's own limits, else `LiveModeNotConfirmedError`)
      -- confirmed here to satisfy D1's "no live call without having
      shown provider/model/limits first" requirement; no additional work
      needed.
      **A real incident found and disclosed during manual verification,
      not swept under the rug**: while manually re-running
      `npm run experiment:phase3 -- capture` to verify this milestone's
      changes end-to-end, I omitted `--config qa.config.mock.yaml`. The
      command's default config path is `qa.config.yaml`, which is
      configured for a **live** Explabs provider (`models.explorer.provider:
      "explabs"`), and an untracked `.env` file (dated 2026-09-07, from an
      earlier session) supplies a real `EXPLABS_API_KEY` that `dotenv/config`
      loads automatically. This means that one command attempted a live,
      unauthorized API call -- a mistake on my part, not a deliberate
      action, and disclosed to the user immediately upon noticing (the
      run's behavior -- one page visited, zero findings, run ending
      quickly -- is consistent with the same HTTP 429 rate-limiting
      already recorded in this project's Phase 2 environment notes, so no
      real cost was very likely incurred, but this cannot be fully
      confirmed after the fact). No further manual CLI verification of
      `experiment:phase3` was attempted after this was noticed, to avoid
      repeating the mistake; the fix itself is independently confirmed via
      the automated test suite instead (`tests/experiments/conditions.test.ts`'s
      existing 5 cases plus the new `conditions-budget.test.ts`'s 2 cases,
      all of which construct their config via `loadTestConfig()` --
      always the deterministic mock provider, never touching `.env` or any
      live credential).
      **A separate, real regression found and fixed while investigating
      the above**: Milestone B's `onProgress` type change (bare string →
      structured `RunProgressEvent`) left three CLI entry points
      (`src/benchmark.ts`, `src/phase2-experiment.ts`,
      `src/phase3-experiment.ts`) still passing `(message) =>
      console.log(message)` -- TypeScript did not catch this because the
      callback's parameter type is inferred permissively and
      `console.log` accepts anything, so it silently printed the raw
      event object instead of the human-readable `.detail` line once the
      type changed. Confirmed via the (accidental) live run above, which
      surfaced the object-dump output; fixed all three call sites to
      `(event) => console.log(event.detail)`, matching `index.ts`'s
      already-correct version and `run-manager.ts`'s structured
      `onProgress: emit`.
      379/379 tests pass (+15 across 3 new files: `tests/models/
      usage-tracker.test.ts` x7, `tests/reporting/usage-reporting.test.ts`
      x6, `tests/experiments/conditions-budget.test.ts` x2), stable across
      two consecutive full-suite runs and before/after `npm run build`,
      typecheck clean.
- [x] Milestone D2 — Human-review fixes.
      **Optional, dataset-specific ground truth**: `import-cli.ts` no
      longer unconditionally loads `fixture/ground-truth.json`. New
      `--ground-truth <path>` / `--no-ground-truth` flags (mutually
      exclusive, one required) -- absence means
      `agreementWithGroundTruth` is omitted from the result entirely (a
      distinct, honest state from "0% agreement", never conflated with
      it), while rater/item/abstention counts are still reported (those
      don't need an answer key).
      **`"unsure"` preserved as abstention**: `computeAgreement()`'s old
      `raterSaysDefect = verdict === "defect"` boolean silently folded
      "unsure" into "not-defect". Now excluded from the
      agreement-with-ground-truth numerator/denominator entirely, counted
      in a new `abstentions` field with its own `itemsWithVerdict`
      denominator (`AgreementResult`, `src/human-review/types.ts`).
      Inter-rater agreement (`pairwiseAgreementRate`) was already correct
      (raw verdict equality, "unsure"=="unsure" already counted as
      agreement) -- confirmed unaffected.
      **Rejects rather than silently drops**: new
      `validateLabelsAgainstMapping()` in `src/human-review/import.ts`
      rejects (throws `HumanReviewImportError`, never silently skips) an
      unknown item id not present in the mapping, and a label file whose
      `exportId` doesn't match the mapping's own `exportId` -- the mapping
      file (`export.ts#exportForBlindReview`) now carries its own
      `exportId` (new `HumanReviewMapping` type) specifically so this
      cross-check is possible; previously the mapping was a bare
      `Record<string,string>` with nothing to check a label file's
      `exportId` against. Conflicting duplicate labels (same rater, same
      item, different verdict) are rejected; an identical resubmission
      (same rater/item/verdict) is idempotent, deduped to one entry --
      confirmed a repeat submission never inflates the independent rater
      count (`raterCount` is computed from the deduped set).
      **New `src/human-review/triage.ts`**: ordinary (non-blind) manual
      triage labels (`Defect`/`Expected behavior`/`Unsure` + notes),
      persisted to a separate `runs/<id>/triage.json`, never mutating the
      original `finding.json`/`report.json` machine decisions (confirmed
      by a test that saves a triage label and re-reads `report.json`
      unchanged) -- re-triaging a finding replaces its own prior label
      rather than accumulating unbounded history. Wired into Milestone
      B's server (`POST /api/runs/:id/triage`, Zod-validated, CSRF/Origin-
      checked like every other mutating route) and surfaced as a small
      per-card select control in the results view
      (`src/server/public/index.html`), visible in ordinary (non-blind)
      mode only -- the blind-review export/import pipeline is untouched
      and still hides machine verdicts/ground truth/mapping files from
      the rater.
      **Blind-mode reachability check**: new test confirms a blind
      review item's `evidenceReferences` are actually resolvable through
      the real artifact-route resolver (`src/server/security.ts
      #resolveArtifactPath`, from Milestone B) against real files on disk
      -- not merely asserted as present filename strings.
      **No fabricated participation, unchanged**: `computeAgreement()`'s
      `{status:"unavailable"}` branch remains the honest default whenever
      no labels are imported or none resolve to a known item -- nothing in
      this milestone invents rater labels or claims a study occurred.
      Rewrote `tests/human-review/export-import.test.ts` (21 tests, up
      from 10) covering every fix above; new
      `tests/human-review/triage.test.ts` (5 tests); extended
      `tests/security/secret-redaction.test.ts` (+1: blind-evidence
      reachability) and `tests/server/security.test.ts` (+3: triage
      CSRF/schema/save-and-read). 397/397 tests pass (+18 net across this
      milestone), stable both before and after `npm run build`, typecheck
      clean.
- [x] Final verification + `docs/PHASE4_ACCEPTANCE.md` + `QUICKSTART.md` +
      README/PROGRESS cleanup. Full raw-output verification pass: `npm
      test` (55/397, stable across repeats and before/after build),
      `npm run typecheck`/`build` clean, `npm run provider:check` (no
      `--live`, no secrets exposed), `npm run qa`/`benchmark -- --config
      qa.config.mock.yaml` (identical known numbers: precision 0.667/0.75,
      9 findings), `npm run challenge-corpus:validate` (20/20 valid),
      `npm run doctor -- --profile fixture` / `orangehrm` (both correctly
      NOT READY, named failures). New `docs/PHASE4_ACCEPTANCE.md` (full
      milestone rollup, known limitations, both disclosed incidents) and
      `QUICKSTART.md`. README's stale "provider usage accounting is not
      implemented" bullet (now false — D1 built it) and stale 172-test/
      Phase-1-only test-suite description corrected; "Running AutoQA"
      section extended with `doctor`/`ui`/`experiment:phase3`/
      `human-review:*` commands and an explicit warning about
      `qa.config.yaml`'s live-provider default (per the incident above).
      `git status`/`git log` confirm HEAD is still `08138be` (Phase 3's
      last commit) -- every Phase 4 change is an uncommitted working-tree
      modification; no push, PR, or GitHub write occurred at any point.

### 2026-09-11 continuation — corrections to the checklist above

An independent review re-examined the Phase 4 pass above against the
actual code (not its own "complete" claims) and found concrete, confirmed
gaps this section corrects. **The checklist items above describe what was
built at the time; several of their "complete"/"enforced"/"correct"
characterizations did not hold up against the real code and are corrected
here, not silently edited in place.** Full detail, file-by-file, is in
`docs/PHASE4_ACCEPTANCE.md`'s "What the 2026-09-11 continuation fixed"
section -- this entry is a pointer plus the specific corrections:

- **A2's "action-level safety" was real but far narrower than its own
  profile schema declared.** `allowedPathPrefixes`/`allowedApiOrigins`/
  `allowedWorkflowKinds` were parsed and stored but never actually
  enforced; a plain unrecognized click and every `fill` action got zero
  policy check; `classifyResourceRequest` checked pathname only (a
  cross-origin bypass); a direct CLI run against a real target bypassed
  `ActionPolicy` entirely (it was only ever constructed by `RunManager`).
  Rewritten this continuation -- see §1 in `docs/PHASE4_ACCEPTANCE.md`.
- **A3's recorder-ordering doc comment was inaccurate.** It claimed
  recorders attach after authentication; the code attached them before.
  Also: a UI-submitted (non-env) password was never redacted from
  evidence/logs at all, and `FormLoginBootstrap` could read a
  never-navigated login page as a successful login if a signal element
  happened to match elsewhere. Fixed -- see §2.
- **D1's "provider usage accounting" undercounted real requests.**
  `UsageTracker.recordAttempt()` wrapped a whole logical decision that
  could internally make a first-attempt AND a repair-attempt HTTP
  request, counting only one. Fixed by moving accounting into each real
  provider's own request boundary -- see §3.
- **"Cancellation is checked between FSM steps" (Milestone B entry above)
  was true but incomplete** -- an in-flight Explorer/Critic SDK call was
  never actually interrupted by Stop (no `AbortSignal` was ever passed
  into an SDK call anywhere); `Promise.race`-based timeouts abandoned the
  losing call rather than aborting it. Fixed -- see §3.
- **"Manually verified live in a real browser" (Milestone B entry above)
  covered a narrower path than the full UI.** This continuation's own
  real-browser verification found and fixed two genuine bugs an HTTP-only
  test could not have caught: the Orchestrator's terminal progress event
  was emitted against the pre-transition FSM state, so the UI never
  learned a run had finished via SSE; and the client fetched
  `report.json` before `assembleReport()` had necessarily finished
  writing it. See §5.
- **A live-execution gate existed only in `RunManager`.** Every other
  entry point that can make a live provider call (`qa`, `benchmark`,
  `experiment:phase3` capture/replay, standalone replay) had none. New
  `--live`-flag requirement added to all of them -- see §3.

New work this continuation with no prior overstated claim to correct:
§4a (Validator no longer reports "rejected" for an all-tooling-blocked
replay), §4b (bounded workflow-prerequisite replay), evidence links,
active-run recovery, live status counters, provider identity in the
profile list, managed fixture-preflight status + server-side preflight
enforcement, fixture/CLI oracle-config parity, and `buildPilotSummary()`
wired into real report assembly (previously dead code).

Verification: `npm run typecheck`/`build` clean; `npx vitest run` 60
files / 470 tests pass (run in isolation); `npm run qa`/`benchmark --
config qa.config.mock.yaml` unchanged (9 findings, same precision/recall);
`npm run doctor -- --profile fixture` now READY with the target-reachable
check correctly showing managed (`~`), not a false failure. `git status`/
`git log` confirm HEAD is `17b6aa9` ("Update AutoQA project" -- the
user's own manual commit of the original Phase 4 pass, made between
sessions); this continuation's own changes remain entirely uncommitted
working-tree modifications on top of it; no push, PR, or GitHub write
occurred.

### 2026-09-14 addendum — the 2026-09-11 continuation's own "Complete" claim for §1/§6 was premature

A follow-up review re-examined specifically the navigation/redirect
policy and preflight-ordering work above with real Chromium probes
against disposable local servers, rather than trusting that the targeted
tests above (49/49) had already passed. **Both claims of completion were
premature.** The code comment claiming "Playwright's `context.route()`
intercepts each hop of a redirect chain as its own separate request" was
empirically wrong -- confirmed by a live probe: an allowed
`/allowed/start` redirecting via 302 to an out-of-scope
`/blocked/destination` resulted in the forbidden destination receiving a
REAL request, policy checked only once. Separately,
`checkScopeConsistency()` checked origin but never
`allowedPathPrefixes`, so an allowed-origin/out-of-scope-path target
still got probed. Full detail, file-by-file, is in
`docs/PHASE4_ACCEPTANCE.md`'s "What the 2026-09-14 addendum fixed"
section -- this entry is a pointer plus the specific corrections:

- **§1a (redirect-chain bypass) -- real fix, not a comment correction.**
  `installRouteGuard()` now manually walks and pre-validates every hop of
  a redirect chain itself via `route.fetch({ maxRedirects: 0 })` before
  ever letting the browser touch it, denying at the FIRST out-of-scope
  hop rather than relying on Playwright to re-surface each hop to the
  route handler (it doesn't). Verified via a real local server counting
  hits on a forbidden destination -- zero, for same-origin, off-origin,
  307, and 308 redirects -- not by inspecting Playwright-side request
  events.
- **§1b (direct `"navigate"` action) -- a real, separate gap the original
  review also missed.** A direct `"navigate"` QaAction skipped the
  `workflows.allowedWorkflowKinds` check a link-click navigation already
  enforced. Fixed with the same check.
- **§6a (preflight path-scope) -- real fix.** `checkScopeConsistency()`
  now checks `allowedPathPrefixes` too, before any reachability probe is
  issued. Verified via a `fetch` spy proving zero requests to an
  out-of-scope path, not merely trusting the reported preflight status.
- **Confirmed still-open, not new: the RunManager TOCTOU race (§5 above)
  was never actually applied** -- only its imports had landed;
  `startRun()` on disk still checked-then-awaited-then-assigned exactly
  as before this addendum. Now genuinely closed with a synchronous
  `starting` flag, verified via a real concurrent-call test (two
  `startRun()` calls with no `await` between them), not a sequential-call
  test.
- **A direct `"navigate"` action and a `"fill"` action had no further
  workflow-kind/other check beyond path-scope** -- the `"navigate"` gap
  is fixed above (§1b); the `"fill"` gap is a disclosed judgment call
  (§1c in the acceptance doc), not silently dropped: a fill alone causes
  no network request, and any autosave-triggered request is still caught
  by the network-layer defense.

New work this addendum with no prior overstated claim to correct: §2
(secret leakage via unredacted URLs/metadata -- `Observation.page.url`/
`.title`, `links[].href`, and `networkRequests[].url` were never
redacted, nor was `report.json`/`report.md`/`benchmark.json`/
`phase2-metrics.json`/`grouping.json`/`pilot-summary.json`), §3
(`phase2-experiment.ts` still bypassed live-gating -- the original
review's fix mirrored `phase3-experiment.ts` but never touched this
file), §7 (Validator's before/after window could include a
prerequisite's own side effect as false reproduction; the
prerequisite-prefix heuristic was unfiltered and unanchored;
`decideStatus` could confidently reject from a single real attempt),
§8a (`FormLoginBootstrap`/`BrowserManager` had no cancellation path at
all), §4 (`BudgetTracker` was checked/recorded once per logical decision,
not once per real HTTP request -- a first-attempt-then-repair decision
could make 2 real requests against a budget of 1), and §9 (hardcoded
test-server ports -- `startFixtureServer()` now defaults to an
OS-assigned port for tests that manage their own lifecycle).

Verification: `npm run typecheck`/`build` clean; full `npx vitest run`
(run in isolation) passes -- see `docs/PHASE4_ACCEPTANCE.md`'s own
"Final verification (raw results, 2026-09-14 addendum)" section for the
exact file/test counts. `git status`/`git log` confirm HEAD is unchanged
from the 2026-09-11 continuation's own confirmation; this addendum's
changes remain entirely uncommitted working-tree modifications; no
staging, commit, push, PR, or paid/live provider request occurred --
mock providers and fake credentials throughout, exactly as instructed.

### 2026-09-15 pass — verified against the working tree, not the prior handoff's own summary

Governing instruction: treat "62 files / 513 tests pass, clean
typecheck/build" as a *reported* result to verify, not proof every
requirement was closed. It was not — this pass found one severe
regression the 2026-09-14 addendum's own fix had introduced, one
previously-undiscovered pilot-blocking bug, and a second bug found only
by exercising the new UI in a real browser. Full detail in
`docs/PHASE4_ACCEPTANCE.md`'s corrected sections; compact acceptance
record in the new `PHASE4_FINAL_ACCEPTANCE.md`.

**The regression**: `observe()` redacted `Observation.page.url`/`.title`/
`links[].href` *in place* — the exact values `Planner` builds navigation
candidates from and `executeAction()`/`Validator.validate()` actually
`page.goto()`. A credential-bearing href became a navigation to a broken
URL; a finding recorded on one could never replay again. No test caught
it because redaction tests checked only that the secret was gone, never
that navigation/replay still worked. Fixed: `Observation` stays raw;
redaction moved to the Explorer prompt, candidate model-facing id/
description (not the actual navigate action's url), and every report/
evidence writer (including `writeFindingJson()`, found to have zero
redaction — a second gap in the same subsystem, closed in the same pass).

**The previously-undiscovered bug**: `profiles/orangehrm.json` had no
`resources.allowedFormSubmitEndpoints` entry for its own login POST, so
a real run would have denied its own login via its own policy. Survived
three prior review passes because every existing auth test passed
`actionPolicy: undefined`. Fixed, with new full-stack tests (route guard
+ action policy + login together, not in isolation for the first time).

**Cancellation bound tightened and quantified**: was "between whole
attempts" only (~80s/~40s worst case, undocumented). Now checked between
individual steps in `FormLoginBootstrap.establish()` and both of
`Validator`'s replay loops plus `Orchestrator.execute()`'s action loop —
concrete new bound ≤15s login-step / ≤5s replay-or-exploration-step,
proven with two new wall-clock-measuring tests.

**Other fixes**: request deadlines now respect remaining run budget
(`Math.min(providerTimeoutMs, remainingDurationMs())`) at all 3 call
sites, including `experiments/conditions.ts`'s previously-missing signal;
`generateRunId()` gained a random collision-resistant suffix; three
narrow redirect-safety test gaps closed (307/308-off-origin, terminal-
response no-double-fetch, native-form body/cookie continuity); a stale
port-registry doc entry removed.

**Profile create/edit UI**: implemented end-to-end (`POST /api/profiles`,
`GET /api/profiles/:id`, a new form section) and verified live in a real
browser via the Claude Browser MCP tools — create, a real inline
validation-error rejection, edit, persistence, and a full "Check setup"
pass against the new profile. **This live exercise found a third bug no
test had caught**: `ProfileStore.list()` filtered `*.json` files, which
also matched the new `profiles/orangehrm.workflows.json` declared-
workflow manifest (added earlier in this same pass), so `GET
/api/profiles` 500'd on every request once that file existed. Fixed
(`list()` now excludes `*.workflows.json`) and covered by a new
regression test.

**Declared-workflow manifest**: new `src/pilot/workflow-manifest.ts`
module (schema, load/save, per-run status tracking mirroring
`human-review/triage.ts`'s exact pattern), wired into `PilotSummary` as a
new `declaredWorkflows` field, honestly `{manifestPresent: false}` when
absent. A real 5-page/10-workflow manifest authored for OrangeHRM
(`profiles/orangehrm.workflows.json`) — prepared, not run (target still
unreachable).

**Real-app pilot**: re-checked, `docker`/`docker-compose`/`php`/`mysql`
still absent from PATH (third consecutive check, identical result). No
privileged software installed, no public demo substituted. Genuinely
blocked by environment, not code — everything independently preparable
(the login-policy fix, the workflow manifest) is done.

**Verification**: `npm run typecheck`/`build` clean; full `npx vitest
run` (isolated) — **64 files / 542 tests pass** (up from 62/513);
`npm run qa -- --config qa.config.mock.yaml` — 9/9 validated, identical
precision/recall/F1 to every prior baseline; `npm run doctor --profile
fixture` READY; `npm run doctor --profile orangehrm` correctly NOT
READY (target unreachable). `git status` confirms this is a real git
repository, HEAD unchanged at `17b6aa9`, every touched file
modified/untracked, nothing staged/committed/pushed. No live or paid
provider request was made. Full detail: `PHASE4_FINAL_ACCEPTANCE.md`.

### 2026-09-16 pass — OrangeHRM deferred by user; cancellation bound corrected after a real-Chromium probe found it false; test-port isolation finished; ordinary-user journey browser-verified

Governing instruction redirected scope: defer the OrangeHRM pilot
entirely ("do not install OrangeHRM, investigate its dependencies, or
let it block further work... mark this acceptance item 'deferred by
user'"), and focus on making AutoQA a reliable, usable *local* QA
application.

**The 2026-09-15 pass's own cancellation-bound claim was false.** An
independent real-Chromium probe requested Stop during a 10-second `wait`
action and found `executeAction()` still returned success ~9.9s later —
the "checked between steps" fix from 2026-09-15 only ever prevented the
*next* unit of work from starting; nothing was wired into whichever
Playwright call was already in flight. Fixed by forwarding the run's
`AbortSignal` directly into every Playwright call that natively supports
one (`Locator.click`/`.fill`/`.press`/`.waitFor`, `Page.goto`/`.reload`/
`.waitForURL`), and replacing `page.waitForTimeout()` (no native `signal`
hook) with a `Promise.race`-based helper — mirroring this project's own
pre-existing, working interruption pattern (`deriveTimeoutSignal()`/
`withTimeout()` in `critic-runner.ts`) rather than inventing a new one.
New measured bound: ~0.5–2s regardless of the interrupted operation's own
timeout, wall-clock-proven in `tests/actions-cancellation.test.ts` (new)
and strengthened tests in `tests/auth/session-bootstrap.test.ts`/
`tests/validator.test.ts`. A pre-existing bug surfaced in the same pass:
a login cancelled mid-retry threw `AuthenticationError{reason:
"cancelled"}`, which `Orchestrator.initialize()` mapped to FSM state
`FAILED` instead of `CANCELLED` — fixed (a cancelled run's report must
say "stopped," never "failed").

**Test-owned port isolation finished.** `runPipeline()`
(`src/run-pipeline.ts`) now always binds a local-fixture target's server
to an OS-assigned port and substitutes the real origin back into `config`
in place before anything downstream reads it, regardless of whatever
literal port the config/profile declares — making the six previously
hardcoded test ports (`tests/helpers/ports.ts`) inert placeholder text,
with *no test-file logic changes required* to become collision-free.
Confirmed on the real `npm run qa -- --config qa.config.mock.yaml` CLI
path too (ran against a dynamically-assigned port, identical findings to
every prior baseline). New `tests/run-pipeline-port-isolation.test.ts`
proves two concurrent runs declaring the same placeholder port land on
distinct real ports.

**Ordinary-user journey browser-verified end to end**, against both the
bundled `fixture` profile and a newly-created `owned-sandbox` profile
pointed at a disposable local HTTP server (never `local-fixture` for
anything meant to exercise `ActionPolicy`, since that environment kind
never constructs one). Confirmed: profile create/edit with explicit
scope, a real inline validation error, provider identity/limits visible,
a genuine reachability probe in Check setup, a mock run actually
exploring the real target, active-run recovery on refresh, Stop halting
in ~2s with partial results preserved (a cancelled fixture run retained 5
validated findings and a full budget/usage snapshot — never zeroed), and
inline screenshots resolving through the artifact route. **One real
usability gap found and fixed**: the "Prior runs" list rendered
unbounded (60+ entries pushed the run controls off-screen in this dev
environment) — fixed with a bounded, scrollable container
(`src/server/public/index.html`), nothing paginated away.

**OrangeHRM**: explicitly deferred by user instruction this pass. No
investigation, dependency check, or installation attempt occurred;
`profiles/orangehrm.json`, `profiles/orangehrm.workflows.json`, and
`docs/ORANGEHRM_PILOT_SETUP.md` are untouched from 2026-09-15 (confirmed
via `git diff`).

**Verification**: `npm run typecheck`/`build` clean; full `npx vitest
run` (isolated) — **66 files / 550 tests pass** (up from 64/542);
`npm run qa -- --config qa.config.mock.yaml` — 9/9 validated, identical
baseline, target dynamically assigned. `npm run doctor --profile fixture`
READY. `doctor --profile orangehrm` deliberately not re-run (deferred).
`git status` confirms HEAD unchanged at `17b6aa9`, nothing
staged/committed/pushed, no OrangeHRM file touched. No live or paid
provider request was made. Full detail: `PHASE4_FINAL_ACCEPTANCE.md`.

## Phase 3 — Reliability and Research Evidence — all 9 sub-milestones
complete (A1, A2, A3, B, C1, C2, C3, C4, D)

- [x] A1 — Evidence invariants (`disposition.ts` L6-vs-disabled ordering
      bug, `evidence-level.ts` unknown-oracle fallback). Fixed by
      computing disposition-for-validated first, then applying an L6
      ceiling to its result (preserves criticEvidenceConflict from the
      contradiction branch, unlike a naive top-level hoist).
      `evidenceLevelForOracle` now defaults unknown oracle ids to L6
      (never L3) with a diagnostic log, never throws. 212/212 tests pass
      (+40: full policy matrix + evidence-level tests), typecheck clean.
- [x] A3a — Fixed the live import-side-effect bug: `main()` ran
      unconditionally at module top level in `index.ts`/`benchmark.ts`/
      `phase2-experiment.ts`, so importing `phase2-experiment.ts` for its
      pure helpers (as the existing test file does) launched a real
      fixture server + browser as a side effect. New shared
      `src/main-module-guard.ts#isMainModule()` uses `realpathSync(argv[1])
      === fileURLToPath(import.meta.url)`, not a naive direct-equality
      comparison (argv[1] is often a relative path; fileURLToPath is
      always absolute — they'd never match even for the genuine entry
      point). Verified `npm run qa`, `npm run benchmark`, and
      `npm run experiment:phase2` all still execute correctly end-to-end
      on Windows with the guard active (not just the new unit test) before
      trusting the fix. New `tests/phase2-experiment-import.test.ts`
      regression-locks it. 213/213 tests pass. (A3's remaining piece —
      the shared ReviewService extraction — tracked separately below.)
- [x] A2 — Evidence aligned with successful reproduction. New
      `src/oracles/signature.ts#sameFailure()` gates `reproduced` on
      matching the ORIGINAL finding's structural failure signature, not
      just the oracle firing again (a different status/endpoint/error no
      longer counts as reproducing). `Validator.validate()` restructured
      to capture every attempt to a temp file until a reproducing attempt
      locks in (or the last attempt, labeled "diagnostic-no-success", if
      none ever does) -- exactly one `trace.zip`/`screenshot.png` still
      persisted per finding, verified via real-browser tests asserting
      exact tracing-invocation counts (1 for immediate success, 2 for
      fail-then-pass, 3 for never-reproduces). New
      `src/critic/evidence-scope.ts` replaces the bare `.slice(-20)`
      console/network truncation with force-include-the-triggering-facts
      + disclosed totalCaptured/omitted/matchedForTriggeringEndpoint
      counts (an endpoint-specific count is never silently compared
      against total page traffic). `schema.ts`'s prompt now wraps console
      messages and page errors in `<untrusted_application_data>` (a real
      gap found during exploration -- they weren't wrapped before, unlike
      `uiTextExcerpt`) and discloses the new scope fields. README's
      Trace-Capture Policy section rewritten to match (previously claimed
      "not a limitation... unchanged since Phase 0," which is now false).
      Full end-to-end acceptance run (`qa.config.mock.yaml`) confirmed
      identical detection/critic results to pre-A2, with exactly one
      trace.zip/screenshot.png per finding directory and no leftover temp
      files. 237/237 tests pass, typecheck clean.
- [x] A3 — Shared, auditable review path.
      - A3a (import-guard fix): done above.
      - Structured claim checks: new `src/critic/claim-checks.ts`
        (`checkClaims`/`firstContradiction`) replaces
        `src/critic/contradiction-check.ts`'s narrow "only N requests"
        regex entirely (file removed). Checks bounded, code-verifiable
        claims only -- `evidenceReferences` naming a real evidence file,
        `requirementConflict` matching an id actually scoped in, and a
        stated request count checked against
        `networkScope.matchedForTriggeringEndpoint` (never total page
        traffic, using A2's scope-disclosure data) -- never a general
        fact-checker; an uncheckable claim never forces report/suppress.
      - **Scoping decision, disclosed rather than silently dropped**: the
        plan called for extracting a standalone `ReviewService` class
        used by both the live orchestrator path and Phase 3's experiment
        conditions. On inspection, the actual duplication the plan was
        worried about didn't really exist: `Critic.review()` (the live
        path) and `phase2-experiment.ts#runConditionB` (the offline path)
        already share the same underlying `buildCriticInput()` and
        `decideDisposition()` pure functions -- there was never a second,
        independently-hand-rolled implementation of that logic to
        consolidate. Building a full class wrapper around functions that
        are already shared would have been a rename, not a fix. Skipped
        it in favor of spending the time on A2 (the higher-risk item) and
        the milestones still ahead; C1's experiment conditions will call
        the same `buildCriticInput`/`decideDisposition` functions
        directly, exactly as `runConditionB` already does.
      - 239/239 tests pass, typecheck clean, full acceptance run
        (`qa.config.mock.yaml`) confirmed identical results.
- [x] B — Conservative cross-finding grouping. New `src/grouping/`
      (`fingerprint.ts`, `group-findings.ts`, `types.ts`), off by default
      (`grouping.enabled`), runs strictly after dedup + critic review, on
      already-reviewed findings. Fingerprint excludes the triggering
      control from the merge key (same defect via different controls
      must group); `oracles/signature.ts` extended to dedupe repeated
      identical failure tuples (a double-click producing 2 identical
      failing requests is the same failure as 1, not a different one --
      found while verifying against the real fixture: without this, H10's
      known duplicate-manifestation artifacts didn't actually group).
      `run-summary.json`/`benchmark.json`/`phase2-metrics.json` stay on
      RAW findings (unchanged denominators, critic/grouping effects kept
      separable); new `grouping.json` measures grouping's own effect
      in isolation; `report.json`/`report.md` are the one place findings
      get an optional `groupId` annotation (raw findings never removed).
      Verified end-to-end on the real fixture: the two known Phase-2
      duplicate-manifestation false positives (FINDING-005/FINDING-003,
      FINDING-006/FINDING-004) now correctly group, and grouping.json's
      own benchmark reaches precision 1.0/recall 1.0/F1 1.0, while
      benchmark.json/phase2-metrics.json stay unchanged from before B.
      254/254 tests pass, typecheck clean.
- [x] C1 — Phase 3 experiment harness. New `src/experiments/`
      (`manifest.ts` capture/verify with sha256-per-evidence-file
      integrity, `conditions.ts` with the 4 descriptive condition ids
      wired through the REAL `selectCriticProvider()` path -- not
      hardcoded `MockCriticProvider`, closing the Phase 2 harness's
      "Condition C could never execute" gap -- `replay.ts`), new CLI
      `src/phase3-experiment.ts` (`capture`/`replay --manifest <path>`),
      `npm run experiment:phase3`. Factored `readEvidenceBundle`/
      `readAttemptScope` out of `phase2-experiment.ts` into shared
      `src/experiments/evidence-reconstruction.ts` (re-exported from
      phase2-experiment.ts for backward compatibility with its existing
      test). Verified end-to-end for real against the fixture: captured
      all 9 findings once, ran all 4 conditions
      (critic_off_grouping_off -&gt; 0.667, critic_on_grouping_off -&gt; 0.750,
      critic_off_grouping_on -&gt; 0.857, critic_on_grouping_on -&gt; 1.000
      precision, recall 1.0 throughout), then replayed the manifest --
      integrity VALID, byte-identical results, confirmed via a dedicated
      test that replay never touches `BrowserManager`. 266/266 tests
      pass, typecheck clean.
- [x] C2 — Benchmark versioning + duplicate-aware matcher. New
      `src/reporting/benchmark-v2.ts`; `benchmark.ts` itself **unchanged**
      (parity test confirms identical TP/FP/FN id sets on the original
      fixture). `matchFindingsV2` adds an explicit `evaluatorVersion`:
      `"v1-oracle-pathname"` (delegates to the unmodified matcher) and
      `"v2-evidence-based"` (one-to-one assignment via
      `grouping/fingerprint.ts`'s structural fingerprint, disambiguating
      two ground-truth entries that share oracleId+pathname; genuine ties
      surfaced as `ambiguousMatches`, never silently broken). Reports
      `uniqueReportableGroups`/`duplicateExcess`, `nonDefectReports`,
      `intendedBehaviorSuppressionCount`, `trueDefectsLost`,
      `needsHumanCount`, `reproductionCounts` -- never a "false positive
      rate" field. `actualRequests`/`wallClockMs` honestly `null`+reason
      (no per-call usage counter exists in the codebase; disclosed in
      README Known Limitations rather than fabricated as 0).
      275/275 tests pass, typecheck clean.
- [x] C3 — Challenge corpus. New `fixture/challenge-corpus/manifest.json`
      (20 cases: exactly the spec's stated floor, 12 distinct-defect + 8
      non-defect) + `src/experiments/challenge-corpus.ts` (load/validate/
      loadOfflineFindings) + `src/experiments/challenge-corpus-validate.ts`
      CLI (`npm run challenge-corpus:validate`). Sized per the plan's
      timeboxing strategy: 13/20 cases are `offline-evidence-record`
      (hand-authored, no browser, each with a non-empty `rationale`), 7/20
      `executable-fixture` (the existing 6 seeded defects + the false-
      positive challenge, reused as-is -- zero new fixture pages added).
      Covers every scenario category the spec lists (expected-failure x2
      more beyond the existing false-positive challenge,
      unrelated-background-traffic, stale-success-text,
      flaky-reproduction, insufficient-evidence, a near-duplicate-distinct
      pair, a genuine-duplicate pair), held-out ~30% grouped by
      `splitGroup` so pairs never split. `npm run challenge-corpus:
      validate` confirmed clean end-to-end. 284/284 tests pass, typecheck
      clean.
- [x] C4 — Blind human review export/import. New `src/human-review/`
      (`types.ts`, `export.ts`, `import.ts`, `export-cli.ts`/
      `import-cli.ts`), `npm run human-review:export` /
      `human-review:import`. Export strips ground truth/critic verdict/
      reportDisposition, uses an opaque random `itemId` (never the
      finding id), writes the id mapping to a SEPARATE file the rater
      never sees. `computeAgreement()` returns
      `{status:"unavailable",reason}` -- never a fabricated number --
      whenever no real labels are imported; negative/inconclusive
      agreement passes through as a valid outcome. **Honest status: no
      live human rater was available in this session.** The
      export/import/agreement machinery itself was verified end-to-end
      against a real `report.json` (9 items exported correctly, no
      ground-truth/verdict/disposition leakage) plus a synthetic,
      single-rater label file for smoke-testing the plumbing only --
      explicitly NOT a genuine human-review result, never presented as
      one. This is the sub-milestone the plan itself flagged as safest to
      leave "complete but unexercised" -- the spec explicitly treats
      `{status:"unavailable"}` as a valid, honest outcome. 296/296 tests
      pass, typecheck clean.
- [x] D — Verification and handoff. Extended
      `tests/security/no-ground-truth-leak.test.ts` (added `src/grouping`,
      `src/validator.ts`, `src/orchestrator/orchestrator.ts` --
      deliberately did NOT add `src/experiments`/`src/human-review`,
      since both legitimately take ground truth as an explicit evaluation
      parameter, same precedent as `src/reporting/benchmark.ts`/
      `src/index.ts`). Extended `tests/security/secret-redaction.test.ts`
      for the new artifact writers -- found and fixed a real gap in the
      process: `phase3-experiment.ts`'s manifest/conditions writes and
      `human-review/export-cli.ts`'s export write didn't apply
      `redactSecrets()` the way `evidence.ts#writeJson` does; fixed both
      for defense-in-depth consistency. README's `TODO: Phase 3` section
      rewritten to `TODO: Phase 4` reflecting what's actually still open.
      Full verification sweep re-run on the final committed state: 298/298
      tests, clean typecheck, `provider:check` (no live calls),
      `npm run qa`/`benchmark` against `qa.config.mock.yaml` (identical
      results to every prior milestone's check), `experiment:phase2`
      confirmed unmodified, `experiment:phase3` capture+replay
      (byte-identical, integrity VALID), `challenge-corpus:validate`
      (20/20 cases valid). Final secret scan across all git-tracked files:
      no stray credential patterns, `.env` confirmed untracked.

### Phase 3 final acceptance result (representative run, `qa.config.mock.yaml`)
- 9 commits on top of Phase 2 (`d1ef412`), one per sub-milestone, each
  independently verified before committing
- 298/298 tests pass, strict typecheck clean
- Detection-level benchmark unchanged from Phase 2: precision 0.667 /
  recall 1.0 / F1 0.8
- Final-report-level (critic only): precision 0.750 / recall 1.0 / F1
  0.857
- `grouping.json` (grouping only, canonical findings): precision 0.857 /
  recall 1.0 / F1 0.923
- Phase 3 experiment harness, critic + grouping combined
  (`critic_on_grouping_on`): precision **1.000** / recall 1.0 / F1
  **1.000** — a clean, reproducible result across all four descriptive
  conditions from a single browser capture, replayed with confirmed
  integrity
- Challenge corpus: 20/20 cases valid (12 distinct-defect, 8 non-defect,
  7 executable-fixture, 13 offline-evidence-record)
- Real bug found and fixed by actually running the grouping pipeline
  against the fixture (not just unit tests): `oracles/signature.ts`
  needed to deduplicate repeated identical failure tuples, or H10's own
  known duplicate-manifestation artifacts didn't actually group
- Two sub-milestones honestly left partial/unexercised rather than
  overclaimed: A3's `ReviewService` class extraction was skipped once the
  underlying duplication it would have fixed turned out not to exist
  (the shared `buildCriticInput`/`decideDisposition` functions already
  served both call paths); C4's blind-human-review machinery is fully
  built and verified with synthetic data, but no live human rater was
  available in this session

## Phase 1 — all 10 milestones complete

- [x] M1 — Phase-0 verification + architecture assessment
- [x] M2 — Explicit orchestrator FSM (states.ts, run-context.ts)
- [x] M3 — Enhanced Observation + page/module mapping
- [x] M4 — QA heuristic framework + 10-heuristic library
- [x] M5 — Multiple deterministic oracle types
- [x] M7 — Safety/navigation improvements + budgets (built before M6, since
      the Orchestrator depends on BudgetTracker + navigation guards)
- [x] M6 — Multi-page autonomous exploration (Planner, Explorer/Provider
      candidate protocol, Orchestrator driver, index.ts rewrite, dedup)
- [x] M8 — Enhanced fixture (5 pages, 5 seeded defects) + benchmark matcher
- [x] M9 — Run-level reporting (report.json/report.md) + coverage metrics
- [x] M10 — Full Phase-1 acceptance run + README + final verification

### Phase 1 final acceptance result (representative run)
- 5/5 fixture pages visited, 100% heuristic coverage (25/25 offered combos)
- 5 findings, all validated (3/3 or better reproduction)
- Benchmark: precision 0.80 / recall 0.80 / F1 0.80 (4 TP, 1 documented FP,
  1 documented FN — SEED-002, since closed in Phase 2 by H11)
- 105/105 tests pass, strict typecheck clean

## Phase 2 — all 10 milestones complete

- [x] M1 — Baseline verification (105/105 tests, clean typecheck)
- [x] M2 — Provider-role separation (`ExplorerProvider`/`CriticProvider`/
      `ModelRouter`), config migration (`models.explorer`/`models.critic`),
      `MODEL_ROLE_CONFIGURATION_ERROR`. Reconciled with a concurrently
      developed, independently authorized Experiential Labs (`explabs`)
      provider integration — see below.
- [x] M3 — Critic contract/schemas (`src/critic/schema.ts`),
      `MockCriticProvider`, evidence-level taxonomy
      (`src/critic/evidence-level.ts`)
- [x] M4 — Disposition model (`src/critic/disposition.ts`), evidence
      contradiction check (`src/critic/contradiction-check.ts`)
- [x] M5 — H11 (safe control activation), closing SEED-002
- [x] M6 — `ui-api-consistency` oracle (checked first in the registry),
      SEED-006 (`/payment` second form), the false-positive-challenge
      fixture (`/expected-failure` + `fixture/requirements.json`), scoped
      requirement loader (`src/requirements.ts`)
- [x] M7 — Critic pipeline integrated into `Orchestrator.validateFinding()`
      after clean-session validation
- [x] M8 — Phase 2 experiment harness (`src/phase2-experiment.ts`,
      `npm run experiment:phase2`) — Condition A (real run, critic off),
      Condition B (post-hoc re-disposition from persisted evidence, no
      second browser run), Condition C (honest `null` — no live
      cross-provider credential available)
- [x] M9 — Two-level benchmark metrics (`src/reporting/phase2-metrics.ts`),
      report-disposition breakdown, `report.json`/`report.md` Phase 2
      sections
- [x] M10 — Full acceptance run, README Phase 2 section, security
      re-verification, local commits only (never pushed)

### Reconciliation note (concurrent editing incident)

Mid-M2, a second, user-operated tool was independently editing the same
working tree (adding the `explabs` provider, role-scoped credential
resolution, secret-redaction hardening, and a `provider:check` diagnostic
script). Both efforts were reconciled rather than one overwriting the
other: the Explabs work was preserved and merged with Phase 2's
provider-role architecture (both providers/credentials route through the
same `ModelRouter`/`resolveProviderCredential` design), and
`MODEL_ROLE_CONFIGURATION_ERROR`'s same-provider check was verified (with
a dedicated test) to correctly reject `requireIndependentProvider: true`
when Explorer and Critic both resolve to `providerId: "explabs"`, even
via two different role-scoped credentials.

### Real bugs found and fixed by actually running Phase 2 (not just unit tests)
1. Playwright's `getByRole(role, { name })` defaults to a case-insensitive
   *substring* match. Adding a second "Amount" field for SEED-006 made two
   controls mutually ambiguous ("Amount" is a substring of "Payment
   Amount"); every `fill` on either threw a strict-mode violation, the
   candidate was never marked executed (a failed action doesn't reach
   `markExecuted`), and it was silently re-offered every cycle, burning
   the entire model-call budget before the run could reach most of the
   app. Fixed at the root by requiring `{ exact: true }` on every
   name-based locator in `src/actions.ts` — this closes the whole failure
   class for any current or future fixture/target, not just this one
   collision.

### Phase 2 final acceptance result (representative run, `qa.config.mock.yaml`)
- 6/6 fixture pages visited, 100% heuristic coverage
- 9 findings, all validated
- Detection-level benchmark: precision 0.667 / recall 1.0 / F1 0.8
  (6 true positives, 3 false positives, 0 false negatives)
- Final-report-level benchmark: precision 0.75 / recall 1.0 / F1 0.857
  (1 false positive suppressed by the critic, 0% recall loss)
- 172/172 tests pass, strict typecheck clean, `npm run qa` /
  `npm run benchmark` / `npm run experiment:phase2` / `npm run
  provider:check` all verified end-to-end from a clean state

## Environment

No `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/reachable Ollama in this
environment (reconfirmed throughout both phases). A live `EXPLABS_API_KEY`
was configured and its configuration/credential-resolution path verified
end-to-end; two live chat-completion attempts both returned HTTP 429
(rate-limited), not retried further per policy. All committed
verification used `MockModelProvider`/`MockCriticProvider` via
`qa.config.mock.yaml`.

## Gemini Explorer integration (2026-09-17)

Added optional Gemini Explorer using official @google/genai 2.23.0. Reuses the existing decision schema, ModelRouter, Playwright executor, deterministic validation, and Critic. Includes explicit model/key configuration, fixed endpoint, no hidden retries, one budgeted output repair, cancellation/timeout handling, usage accounting including thinking output, and secret-redaction coverage. No default profile/config switch, live provider requests, screenshot reasoning, or Gemini Critic.

Targeted validation: typecheck plus 30 new tests passed, including real local Chromium pipeline execution with intercepted Gemini HTTP. Full regression verification passed: 580 tests in 68 files; build and typecheck passed. See docs/GEMINI_PROVIDER.md for scope and setup. Existing OpenAI/Ollama placeholders remain unchanged. No commits or pushes.

## Phase 5 — Ajeer compatibility and workflow pilot (2026-09-17)

Implemented scoped authentication exceptions, authentication-only RunManager/UI runs, optional executable declarations in the existing planner/FSM, exact action/route policies, bounded unsuccessful candidates, opaque navigation IDs, workflow assertions and immutable evidence, selected-workflow runs, phase-specific accounting and deadline propagation, validated annotations and derived pilot reports. Existing fixture defaults, oracles, reproduction, Critic disposition, grouping and human-review separation remain in place.

Ajeer discovery stayed unauthenticated and separate from AutoQA acceptance. The prior failed run was verified as zero exploration actions/zero model calls; login success was not established. The existing private profile was updated, not recreated. Its auth placeholders are flagged unverified and the newly created ignored workflow manifest is intentionally empty. Doctor returned NOT READY for that precise blocker despite HTTP 200 reachability. No chat-supplied credentials were used or copied into artifacts, .env was not read by the assistant, and no real authentication was performed, and no authenticated features were invented. No paid provider calls, staging, commits, pushes, PRs, deployment or OrangeHRM changes were made by this pass.

Full verification totals and remaining live gates are recorded in PHASE5_ACCEPTANCE.md. See AJEER_PILOT_REPORT.md and docs/AJEER_PILOT_SETUP.md for evidence and the next user action.

Final Phase 5 verification: typecheck and build passed; full suite **598 tests / 70 files passed** in 218.64 seconds. This is 18 new tests over the current Gemini-era baseline. A first 597-test full pass was followed by one accounting-boundary correction/regression and a clean final full pass. The UI is running at http://127.0.0.1:4180 and serves the new controls. Live Ajeer acceptance remains pending observed authenticated URL/signal and credentials supplied through the transient UI.

## Local (no-cost) Explorer via Ollama (2026-09-21)

Implemented `OllamaModelProvider` (`src/models/ollama-provider.ts`), a text/DOM Explorer adapter for a local Ollama server, reusing the existing decision schema, ModelRouter, budget/usage accounting, and secret redaction exactly like the Gemini integration. Removed `"ollama"` from `run-pipeline.ts`'s `UNIMPLEMENTED_PROVIDERS` (only `"openai"` remains blocked) and wired `OLLAMA_BASE_URL`/`OLLAMA_MODEL` through `selectProvider()`. The adapter is loopback-only by construction (`assertLocalOnlyUrl()` rejects any non-`127.0.0.1`/`localhost`/`::1` host, any non-`http:` scheme, and any redirect response) — it can never be pointed at a remote or cloud host even by misconfiguration. No Ollama Critic was built (explicitly out of scope for this pass).

Zero budget for API services/cloud/infra, and disk space was tight — per explicit user instruction, **Ollama was not installed and no model was downloaded in this pass**, regardless of whether it would technically have fit (~4 GB binary + ~0.4–1.5 GB for a small instruct model against 16 GB free). Everything delivered here is implemented and verified fully offline. Added `qa.config.ollama.yaml`, an opt-in real-smoke-check branch in `provider-check.ts --live` (reachability + model-presence via `/api/tags`, then one bounded decision — only reachable once the user installs Ollama themselves), and `src/experiments/local-explorer-benchmark.ts` (`npm run local-explorer:benchmark`) — a decision-quality evaluation (schema validity, offered-candidate compliance, appropriate stopping, prompt-injection resistance) over frozen synthetic cases, run against Mock always and Ollama when reachable; explicitly not a defect-detection precision/recall measurement, and the full end-to-end fixture-pipeline comparison was left as a follow-up rather than half-built.

Research (sources, hardware facts, and the Ollama-over-llama.cpp decision) is recorded in `docs/LOCAL_EXPLORER_RESEARCH.md`. New tests: `tests/models/ollama-provider.test.ts`, 24 tests against a fake local HTTP server — zero real network, no running Ollama, no API key. `tests/models/gemini-provider.test.ts`'s combined `["openai","ollama"]` "not implemented" assertion was split so only `"openai"` still throws. No staging, commits, pushes, PRs, or deployment.

## Phase 6 verification closure — recorded 2026-09-21

Recovered the completed 2026-09-18 regression result after the interrupted turn: all 598 tests / 70 files passed in 219.57 seconds, following the direct no-network assertion correction in the preflight test. Targeted preflight: 10 passed; typecheck and build passed. The initial full run had one startup-timing failure (597 passed); the final result supersedes it. Authenticated Ajeer acceptance remains pending, as recorded in PHASE6_ACCEPTANCE.md and docs/PHASE6_READINESS.json. No authenticated workflow or Gemini request was executed in that phase. The user authorized GitHub synchronization on 2026-09-21, superseding the earlier no-commit/no-push instruction for this sync.

## GitHub synchronization verification — 2026-09-21

Typecheck and build passed for the current tree, including the local Ollama additions. The full suite completed in 272.31 seconds with 621 passing tests and one failure across 71 files (622 tests): tests/run-manager.test.ts, user-initiated Stop terminal event, expected stopped but last observed checking-setup. An unchanged isolated rerun passed (1 passed, 11 skipped, 3.51 seconds). This suggests timing sensitivity but does not erase the full-suite failure; cancellation-event reliability remains a follow-up. No production behavior was changed to make the check pass. Source, tests, configuration examples and sanitized documentation are included in the authorized sync; credentials, private profiles, run artifacts, raw browser evidence/reports and nested local folders remain local. HTTPS access was verified after SSH authentication failed. No live model requests or deployments were performed.

## Making the local product actually work — 2026-09-21 (continuation)

Reproduced the UI issues live (real 1920x1080 browser, real control panel) rather than trusting the "checking-setup" flake noted above as harmless, and root-caused four real defects:

- **Cancellation event loss (the actual bug behind the flake above, confirmed by reading the code, not by rerunning):** `Orchestrator#initialize()`'s early-return branches (login failure/cancellation, initial-navigation failure/cancellation, post-auth budget exhaustion) transitioned to a terminal state but never called `this.progress()` — `run()`'s own while loop is the only other place a terminal event fires, and its condition is already false once `initialize()` itself returns terminal, so that loop body never runs. Fixed all three branches in `src/orchestrator/orchestrator.ts` to emit progress before returning, mirroring the existing pattern the main loop already used. Added `tests/orchestrator/cancellation-progress.test.ts` — two deterministic tests (abort exactly during login, abort exactly right after login succeeds/before initial navigation) using a wrapped `SessionBootstrap` against a real local login fixture, not a sleep race. Confirmed both fail against the pre-fix code (via `git stash`) and pass against the fix. Verified live in the running UI: Start → Stop now reliably lands on a clean "Stopped" terminal state with Start re-enabled.
- **"No workflows configured" dead-end:** was a plain `Error` thrown only at Start time, invisible to "Check setup" (`runPreflight()` had no workflow-related check at all). Added a `workflows-configured` informational check to `src/preflight/doctor.ts` (never blocks `overallReady` — an auth-only run is valid with zero workflows), a typed `NoWorkflowsConfiguredError` in `src/run-manager.ts` mapped to a clear 400 in `src/server/routes/runs.ts`, and client-side guidance in `index.html` that auto-checks "Authentication only" and explains why when this specific error occurs.
- **UI "very small" on a real monitor:** reproduced at 1920x1080 — the form sat in a ~400px column pinned to the left edge (no `margin:auto`, no responsive breakpoint) despite correct viewport meta/font sizes. Fixed in `src/server/public/index.html`'s CSS; also added a `setup-status-line` that auto-runs "Check setup" on profile load/change and shows one plain-language next-action sentence, and fixed `doctor.ts`'s confusing mock-provider wording ("not-configured" reading as broken when mock is working as designed by not needing a credential).
- **Benchmark scoring gamed by an always-stop provider:** `src/experiments/local-explorer-benchmark.ts`'s `acceptableChoice` unconditionally accepted `"stop"` on every case regardless of whether that case's `acceptableCandidateIds` included it — a degenerate always-stop provider scored "acceptable" on cases where real work was required. Fixed to only accept `"stop"` when the case itself lists it. Added `tests/experiments/local-explorer-benchmark.test.ts` with a real always-stop fake provider proving the fix (and that it would have failed pre-fix).

Verified live through the actual UI, not just tests: selected the local fixture profile, Check-setup auto-ran and showed READY, started a Demo run to completion with real fixture findings (6 reportable, matching known fixture defects, clearly distinct from any Ajeer content), started a second run and Stopped it mid-flight — clean terminal state, Start re-enabled, Stop hidden, both times.

Re-ran `npm run benchmark -- --config qa.config.mock.yaml` fresh rather than repeating the stale "1.0/1.0/1.0" figure quoted elsewhere in this file: current fixture result is precision 0.667, recall 1.000, F1 0.800 (6/6 seeded defects found, 3 additional validated findings beyond the 6-item ground truth list) — reported as-is, not investigated further this pass.

Full verification: typecheck and build passed. `npm test` full suite: 4 failures out of 625 tests across 73 files in this run (up from 621/622 tests/71 files before this pass's new test files) — `tests/run-manager.test.ts`'s `actionsPerformed` assertion and three unrelated timeouts (`tests/pilot/phase5.test.ts`, `tests/reporting/assemble.test.ts`, `tests/security/secret-redaction.test.ts`). All four independently re-run in isolation and passed; none touch code changed this pass. Consistent with CPU/RAM contention on this machine (4 cores, 16GB RAM, dozens of concurrent Chromium instances across Vitest's parallel file execution) rather than a regression — reported as observed, not asserted as harmless without the isolation check. `npm run doctor --profile fixture` READY; `npm run doctor --profile ajeer` still NOT READY (unverified auth placeholders, empty workflow manifest — unchanged, live Ajeer acceptance remains pending the user's own sandbox login).

Not done this pass: the local auth-discovery UI flow (observing a real authenticated URL/heading without hand-editing profile JSON) and the resulting live Ajeer authenticated pilot — both require the user's own credential entry, which cannot happen in chat, and the discovery UI itself is substantial new work reasonably scoped as a follow-up rather than rushed alongside four already-verified fixes.

## Auth-discovery feature + re-verified baseline — 2026-09-22

A new session picked this up after a 5-day gap with no shared context; per its own instruction, every claim in its brief (git remote, commit hashes, test counts, "checksVerified") was independently verified against the actual repo before anything was built, rather than trusted. All were substantially accurate; the only correction needed was that the "621/622, one Stop-event failure" and "4 failures / 625" snapshots quoted in the brief were both already-stale -- a fresh full-suite run this pass came back **73 files / 625 tests, zero failures**, confirming the prior pass's own explanation (CPU/RAM contention during parallel execution, not a real regression) was correct.

Built the auth-discovery feature scoped out above: `src/auth/discovery.ts` (`runAuthDiscovery()`) performs exactly one login attempt purely to observe the result -- reusing the profile's own already-correct `loginUrl`/`usernameField`/`passwordField`/`submitControl` locators and the same `installRouteGuard()`/`auth.allowedRequests` scoping a real run uses, but deliberately never checking the (placeholder) `successUrlPattern`/`authenticatedSignal`, since establishing those is the point. Returns only `{observedUrl, candidateSignals}` (up to 5 visible heading/nav landmarks as `{role, name}`) -- no screenshot, no trace, no request body, nothing written to disk. New route `POST /api/profiles/:id/auth-discovery` (`src/server/routes/auth-discovery.ts`) and a new "1c. Authentication setup / discovery" UI section (`index.html`) that calls it, lets the user review/adjust the suggested signal and URL pattern, and saves only those two fields plus `checksVerified: true` through the existing profile-save route -- no new persistence path. `tests/auth/discovery.test.ts` (3 tests, real disposable HTTP server) proves it observes a genuine post-login URL/landmark while ignoring the profile's own wrong placeholders, that the submitted credential never appears in any log line it writes, and that the `auth.allowedRequests` exception it relies on is genuinely narrow (denied outside the login window, same as a real run).

Closed the one cancellation point without deterministic coverage: "before browser creation" (`chromium.launch()` itself takes no `AbortSignal` and isn't abort-aware). Two new tests in `tests/orchestrator/cancellation-progress.test.ts` prove this gap is bounded, not indefinite -- Chromium still launches and is still cleanly closed, and the run still reaches a genuine terminal `"stopped"` event once control reaches the next signal-aware check point, for both a form-login and a no-auth profile. All 5 of the previously-named cancellation points (before browser creation / during setup / during login / during a workflow action / during validation or a provider request) now have deterministic (non-sleep-based) coverage.

Re-verified live in a real browser rather than trusting the prior commit's own message: the centering/layout fix, the setup-status wording (mock reads "no API key or local model needed," never "not-configured"; login reads "unverified placeholders" with a concrete next step, never a false "succeeded"), and the workflow-dead-end guidance all render exactly as claimed at 1920x1080. Re-ran the fixture walkthrough end-to-end through the real UI: a Demo run to completion (6 pages, 74 actions, 8 reportable + 1 suppressed finding, all evidence links resolving, clearly labeled distinct from any Ajeer content), then a second run started and Stopped mid-flight (clean "Stopped -- cancelled by user" terminal state within ~2s, Start re-enabled). Read (not re-derived) the already-fixed benchmark-scoring regression test and confirmed it genuinely proves an always-stop provider no longer scores "acceptable" on cases requiring real work.

Full verification this pass: `npm run typecheck` clean, `npm run build` clean, full `npx vitest run` -- **74 files / 630 tests pass, zero failures** (up from 73/625: one new file, `tests/auth/discovery.test.ts` (3 tests), plus two new tests added to the existing `tests/orchestrator/cancellation-progress.test.ts`). `profiles/ajeer.json`'s `checksVerified` remains `false` as of this writing -- the auth-discovery feature is built and browser-verified to render correctly, but the user had not yet run it through their own browser (required, since it needs their real sandbox credential) at the point this entry was written. No live/paid provider request was made; mock providers throughout. No `.env`, private credential, seeded ground truth, or historical run artifact was modified. The untracked working-directory items (`kowshi1119/` -- a wholly unrelated nested git repo with its own `.git`/remote; `.playwright-mcp/`, `.profile-preview/` -- unrelated scratch/build directories; the `AjeerMoney_*`/`Bug_Report_*` `.docx`/`.html`/`.md` files and their `build_report*.js` generators -- a separate, already-complete manual QA engagement's deliverables) were identified and classified but deliberately left untouched -- none belong in an AutoQA commit.
