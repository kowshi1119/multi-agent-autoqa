# Ajeer sandbox pilot setup — Phases 5–6

## Latest status — 2026-09-23

Existing normal-run authentication evidence RUN-20260923-075117245Z-df87 was independently checked: success, four actions. Repeating discovery is not required merely because older notes below say login was blocked. The workflow manifest remains empty. The next live task is observing and declaring actual read-only workflows with a fresh locally entered credential, then executing one, the remainder, and a fresh repetition. No credentials or persisted browser sessions are recovered from prior chat/history.

The new standalone API/security checks do not reuse browser authentication; authenticated profiles are explicitly unsupported for that HTTP phase. Cross-account probing is supported only for the fixed local fixture, never Ajeer. Existing read-only target scope and budgets remain unchanged. See the latest PHASE6_ACCEPTANCE.md checkpoint; older sections below are historical.

## Current setup path — 2026-09-23

Run **npm run ui**, select Ajeer and Demo. Enter credentials only under the local **Discover** form. Choose a stable, non-personal verified heading and save the observed conditions. Then enter credentials again under **Sign in for this run**, select **Authentication only**, and Start. Discovery does not count as acceptance; require a successful normal-run authentication report before declaring workflows. Cancel closes discovery without saving conditions. Same-route login, MFA, CAPTCHA and interactive SSO are unsupported.

The profile now has saved checks but still no successful authenticated acceptance. Rediscovery is necessary because an old text-derived banner suggestion may not be an accessible landmark name. No placeholders should be marked verified. The product discovery path works independently of the external CUA tool. Current offline verification: 642 tests/76 files plus 11 final targeted tests passed. See [current Phase 6 evidence](../PHASE6_ACCEPTANCE.md). The sections below retain earlier setup history, not current configuration claims.

## Historical setup record

Status: **independent implementation verified (598 tests / 70 files); Ajeer live acceptance pending**. OrangeHRM remains deferred. Paid/live-provider evaluation is separate.

## Phase 6 checkpoint — 2026-09-18

The local UI address was checked again: http://127.0.0.1:4180/ responds HTTP 200. Both configured providers resolve to mock. Ajeer reachability passes, but readiness still fails for the unverified authenticated URL/signal. No live run was started and no workflow declaration was guessed. See [Phase 6 readiness](PHASE6_READINESS.json) and [acceptance record](../PHASE6_ACCEPTANCE.md).

The immediate action is a user-controlled sign-in to the Ajeer website, followed by sharing **only the final URL and an exact visible heading or navigation label**. Those are configuration observations, not account credentials. Browser inspection currently cannot initialize in this environment. Once the checks are configured from observation, enter credentials only in the local AutoQA panel for the authentication-only run. A sign-in performed manually for discovery does not count as AutoQA authentication acceptance.

## Authorized boundary

The existing authorization recorded on 2026-09-17 covers the dedicated sandbox test account at `https://portal.sandbox.ajeer.money`. Navigation and API origins remain exactly that origin. Begin with read-only workflows. Financial transactions, approvals, transfers, account changes, deletion, invitations, messages, uploads and other persistent mutations are excluded.

Authentication has a separate, lifecycle-scoped `auth.allowedRequests` list of exact origin/method/path triples. The local Ajeer profile carries the previously observed POST `/api/logout`, `/api/v1/auth/client-token`, and `/api/v1/auth/login`. They are available only while SessionBootstrap is establishing a session, not during exploration. `resources.allowedFormSubmitEndpoints` is empty. Observing a request does not authorize any additional endpoint or origin.

Credentials belong only in the existing **Sign in for this run** fields. They are transient, cleared from the UI after submission, never written to `.env` or profile JSON, and never requested in chat. Authentication recorders remain disabled during login. Traces remain disabled for real targets; browser storage state is held only in memory for validation. MFA, CAPTCHA and unsupported SSO are not bypassed.

## Verified observations and remaining configuration

`docs/AJEER_DISCOVERY.json` is explicitly **browser-assisted unauthenticated discovery**, not AutoQA pilot evidence. It confirms root → `/login`, email/password inputs and a Login submit control. The page attempts logout and client-token POSTs on load; the discovery denied both. The login submission endpoint comes from the historical denial evidence, not a new credential submission.

The historical AutoQA run `RUN-20260916-121442769Z-0b77` failed authentication with zero recorded actions and zero model calls. That historical action counter excluded authentication; it is not proof that zero browser operations occurred.

No credentials were supplied through the transient local UI during this implementation session. Chat-supplied credentials were not used or copied into artifacts. The authenticated URL and page-specific visible signal have **not** been observed. The local profile retains the old placeholders but sets `auth.checksVerified: false`; preflight and bootstrap refuse to treat them as usable acceptance checks. Do not set this flag true until replacing both values from actual observation. A generic navigation landmark is not sufficient.

`profiles/ajeer.workflows.json` now exists and intentionally contains empty `pages` and `workflows` arrays. It claims no unobserved features. Define 3–5 read-only workflows only after authenticated discovery. Both Ajeer files remain Git-ignored private configuration. The manifest was previously missing despite the old setup documentation claiming it existed.

## Start and run

1. From the project directory, run `npm run ui`. Open `http://127.0.0.1:4180`. This is also the command in `.claude/launch.json`; no additional local skills/hooks/commands were present.
2. Select the Ajeer profile and **Demo / mock** mode. This forces mock Explorer and mock Critic even if another profile defaults to a live provider. The target remains the real sandbox; “mock” describes model providers only.
3. First complete authenticated discovery with the dedicated test account under user control. Supply only non-secret metadata: the final authenticated URL and an exact stable visible signal (for example an observed role/name). Update `auth.successUrlPattern`, `auth.authenticatedSignal`, and then `auth.checksVerified` through the profile editor. Do not guess values or broaden request policy.
4. Use **Check setup**. `npm run doctor -- --profile ajeer` is the equivalent diagnostic. READY means configuration/reachability checks passed, not that login succeeded. While checks remain unverified, NOT READY is expected.
5. Enter credentials only in **Sign in for this run**, select **Authentication only**, and Start. Read `authentication.json` in Results. Require success with URL and visible-signal checks before proceeding. Stop works during login and execution.
6. Author observed workflows in the private manifest using the format below. Clear Authentication only. Enter one workflow ID for the first workflow run. Run the remaining workflows only after that succeeds. Repeat at least one completed workflow in a new run; each run gets separate evidence.
7. Inspect Results → Authentication and declared workflows. The result distinguishes `attempted`, `completed`, `blocked`, `unsupported`, and `failed`. A failed assertion is not automatically an application defect. Existing deterministic oracles, fresh-session reproduction, Critic disposition and grouping remain the finding pipeline.
8. Use **Save annotation** to record a later outcome/reason and run-relative evidence paths. Completion requires original passing assertion evidence. Original run reports and `workflows/<id>.json` remain unchanged; `pilot-summary.latest.json` refreshes coverage and ordinary triage. This does not manufacture independent human review.

`qa` still accepts `--config`, not `--profile`. Use the UI/RunManager path for authenticated profile runs.

## Workflow format (synthetic example, NOT an Ajeer feature claim)

```json
{
  "schemaVersion": 1,
  "profileId": "example",
  "pages": ["/home", "/records"],
  "workflows": [{
    "id": "view-records",
    "kind": "navigate",
    "page": "/home",
    "description": "Open the observed record list",
    "preconditions": "Authenticated; home page loaded",
    "authorizedActions": "Click the observed Records control",
    "expectedOutcome": "The record list is visible",
    "evidenceRequired": ["Structured completion assertion and executed step log"],
    "limitations": "No business-value or financial correctness assertion",
    "execution": {
      "steps": [{
        "pathname": "/home",
        "resultingPathname": "/records",
        "action": {"type": "click", "target": {"role": "button", "name": "Records"}}
      }],
      "completion": {"urlPattern": "/records$", "visible": {"role": "heading", "name": "Records"}}
    }
  }]
}
```

`workflows.executionMode: "declared"` disables generic input-boundary/double-submit probes and unrelated navigation candidates. Actions, target locators, fill values, route preconditions and expected results come from the manifest. `kind` must be included in `allowedWorkflowKinds` (omission means navigate). Scoped SPA controls are allowed only for the exact declared action/route; DOM submit checks and the network guard still apply. Use `resultingPathname` for asynchronous SPA transitions. If a workflow depends on a prior state, include its explicit authorized navigation/setup steps; selecting an isolated workflow does not fabricate its preconditions. Unsupported capabilities should omit `execution`, yielding `unsupported`.

The engine persists structured assertion/step evidence, not a new screenshot-based oracle. Evidence requirements are descriptive; do not declare screenshots, business calculations or API expectations as fulfilled by this interpreter. Optional profile `requirements` and `oracles` reuse existing engine schemas. Add only supported, observed expectations.

## Counters and limits

Limits remain **25 actions, 20 Explorer decisions, 5 pages, 5 findings, 5 Critic calls, 180 seconds per run**. Never silently increase them after a failure.

For declared runs, `budget.actionsUsed` includes each attempted login navigation/fill/submit, setup navigation, workflow action, replay navigation, prerequisite and replay action. Failed/blocked attempts consume actions; checks occur before every action in a sequence. Assertion waits consume time, not a second action. At most two login attempts are allowed, with no retry for missing configuration/credentials, cancellation or budget exhaustion. Each workflow is selected at most once per run. Unchanged unsuccessful heuristic candidates are not reoffered.

`actionOutcomes` separates attempted/successful/blocked/failed executor operations; a successful click can still produce a blocked network request, which prevents workflow completion. `browserRequestsByPhase` counts browser-emitted requests (including assets and denied requests), not redirect-validation transport probes. `modelCallsUsed` counts mock decisions; provider `usage.*.requests` remains zero. Critic calls count actual reviews, not workflows. Mock Critic output is not independent human verification.

Pages count distinct observed paths; direct navigation and declared SPA destinations are checked against remaining page budget. An unexpected application route can be observed before its mismatch is detected; it is blocked/incomplete and stops further expansion. Auth navigation does not count as product-page coverage. Validation requests/actions are separately phase-accounted. Legacy fixture action totals retain their existing semantics. Preflight is outside the run duration; the run deadline covers browser setup, authentication, actions, validation and assertion waits.

## Acceptance still pending

- Observed authenticated URL plus specific signal; real transient credentials through the UI.
- Successful AutoQA authentication-only acceptance and failed-login/Stop checks against Ajeer itself.
- 3–5 observed, approved workflows; one-workflow run; remaining-workflow run; repeat run.
- Real run IDs, assertion evidence, budget totals and human triage where actually performed.

Zero confirmed bugs is valid. Ajeer precision/recall are N/A without an independently labeled reference set. Offline regression and fixture metrics are not Ajeer acceptance or live-model performance evidence.
