# AutoQA Phase 4 — Easy Local Use and a Real-Application Pilot

You are my senior QA lead, TypeScript architect, and product engineer. Implement Phase 4 in my existing AutoQA repository, https://github.com/kowshi1119/multi-agent-autoqa.

The engine is becoming difficult for me to operate, and it has not yet been tested on a realistic application. The outcome I want is simple: choose a project, check setup, log in when needed, run safe QA, stop a run, and review understandable evidence. Prove this on one self-hosted real application as well as the existing fixture.

Build a small local control panel around the existing engine. Prioritize working behavior and honest results over feature breadth. This phase is a usability and real-application pilot, not a production SaaS platform or a 30–50 defect research study.

Complete authorized implementation and verification; do not stop at a plan. Make routine implementation choices yourself. Ask only for missing information or externally required approval that blocks dependent work, and continue independent work meanwhile. Do not ask for confirmation after every milestone.

## 1. Inspect the actual repository and repair the baseline

Read applicable AGENTS.md/CLAUDE.md instructions, Git status/diff, package.json, vitest.config.ts, tsconfig.json, README.md, PROGRESS.md, src/config.ts, browser/session code, actions, Planner/heuristics, Validator, Critic, reporting/grouping, experiments, and human-review code. Do not reset or overwrite existing user work.

The review on 2026-09-10 found local HEAD 08138be. The user handoff describes Phase 3 as complete, with 298 tests and fixture-only critic-plus-grouping precision/recall/F1 of 1.0. Treat those numbers as a small deterministic benchmark result, not evidence of real-world accuracy.

Important current working-tree facts to recheck:

- package.json and package-lock.json already contain uncommitted dependency changes, including Vitest ^4.1.11. Preserve them unless a justified compatibility fix is required. Do not silently revert the upgrade.
- Typecheck passed during review.
- Default npm test discovered both source tests and compiled dist/tests copies. A compiled Validator suite timed out after EADDRINUSE on port 4196. The resulting inflated count was not a valid pass.
- npm test -- --exclude 'dist/**' passed all 298 source tests in 41 files. Fix normal test discovery explicitly so npm test passes both before and after npm run build. Prefer temporary OS-assigned ports for browser-test servers where practical. Do not hide the collision by increasing timeouts, deleting dist as the only workaround, or skipping meaningful tests.

Record the actual baseline and milestone checklist in PROGRESS.md, then implement in dependency order.

## 2. Preserve the engine and keep scope bounded

Keep the existing deterministic FSM, Planner/candidate protocol, provider-role separation, direct Playwright execution, clean-context Validator, evidence taxonomy, Critic decisions, structural grouping, and replay/evaluation artifacts. Reuse one execution and report-assembly path from both CLI and UI; do not implement a second QA engine or scrape console text as the main progress API.

Preserve existing CLI commands and additive config compatibility. Keep fixture-specific profiles separate from real-application profiles. A real target must never be relabeled local-fixture to unlock heuristics or benchmark behavior.

Do not add a cloud service, hosted deployment, Electron packaging, multi-user accounts, PostgreSQL, Redis, vector database, plugin marketplace, more agent roles, a new orchestration framework, broad provider expansion, cross-browser grid, visual regression, or full accessibility testing. The control panel is a loopback-only local application. Use the smallest maintainable UI/server approach that fits this repository; justify each new dependency. Existing JSON artifacts can supply run history.

Do not push, create PRs, or make GitHub writes. Leave changes local. Do not add an AI co-author footer. Never copy keys from old chats into files or logs.

## 3. Milestone A — Safe real-target profiles and authentication

### A1. Project profiles and preflight

Add schema-validated, versioned project profiles that store non-secret settings: name, target URL, environment, allowed navigation origins/path scope, permitted API/resource origins, allowed workflows/actions, authentication mode, provider selection, and run limits. Use explicit environment types for new profiles while preserving supported legacy configuration.

Provide two initial profiles: existing AutoQA fixture, and self-hosted OrangeHRM. Support a custom owned/sandbox target without promising universal login or workflow support. Store credentials only as secret references or transient run input, never in saved project JSON/YAML.

Add a reusable preflight service and a simple diagnostic command, such as npm run doctor. Check configuration, browser availability, approved target reachability, scope consistency, required login configuration, and configured provider credentials/implementation. Probe only the target selected by the user, with bounded timeouts; do not scan arbitrary services. Report named failures with a next step, without opening an exploration run or making paid model calls.

Distinguish provider states: not configured, configured but unverified, verified by a successful live request, rate-limited, unavailable, and unsupported. Credential presence does not mean a provider works. Do not silently fall back from a selected live provider to mock.

### A2. Action-level safety before any real run

Inspect src/qa/heuristics/support.ts: buildFillAndMaybeSubmit automatically appends a form submit. A heuristic labeled safe can therefore modify persistent data. Audit all generated actions, including navigation, fills/autosave, Enter, and implicit submission; H10/H11 gates alone are insufficient.

For real-target profiles, allow only explicitly identified read/navigation/search/filter/sort/pagination workflows. Require stronger contextual identification than a button name: include route, form/control context, and associated request behavior. Unknown actions are not offered. Recheck the policy at execution and during Validator replay, not only in the UI or Planner. Keep H10 disabled for this pilot.

Add request-level defense for unapproved mutations, including fetch/XHR and implicit submissions. Permit narrowly scoped login and verified read-only POST/search endpoints when required; HTTP method alone does not prove safety. Account for reads with side effects, ambiguous GET links, autosave, and approved resource/API origins. Do not block required application assets indiscriminately or loosen all origins to make the page work. Configure service-worker behavior so it cannot silently bypass the pilot's interception policy. Disclose unsupported WebSocket/iframe/popup flows and skip them instead of weakening protection.

A request aborted by AutoQA, a denied action, a locator failure, expired authentication, a timeout, or a provider outage is a tooling/environment outcome, not a product defect. Keep safety-induced network errors out of defect oracles while retaining an audit record.

Use synthetic local data and a dedicated test account. Keep deletion, saving/editing HR records, leave approvals, role/password changes, uploads, emails, payments, and persistent mutation tests outside this pilot. Initial installation/seed setup is a separate controlled operation on a dedicated local instance.

### A3. Authentication works in exploration AND validation

Add a small generic deterministic session-bootstrap interface. Support no-auth and a configured username/password form login, with OrangeHRM supplied as a profile/adapter. Prefer stable role/label/test-ID locators. Do not hardcode OrangeHRM into core Planner, Validator, or oracles. Keep observed form locators and authenticated-page checks configurable.

Check success using stable URL and authenticated UI signals. Missing/invalid credentials and missing post-login signals yield explicit authentication failures. No autonomous CAPTCHA/MFA bypass and no negative-login stress tests in this phase.

Every fresh Validator context must establish an equivalent authorized session before replay. Never reuse the Explorer's live context as validation. If reusable storageState is appropriate, copy a minimal bootstrap state into fresh contexts and verify the protected page is accessible; sessionStorage or app-specific requirements may require deterministic re-login instead. Bound login attempts and refreshes to avoid loops and lockouts. Fresh browser contexts do not reset server-side data: state this limitation and keep the pilot read-only.

Preserve necessary workflow prerequisites in replay, such as opening a list and applying a filter. Do not assume goto(finding.url) plus only the final candidate is sufficient for a stateful application. Record a bounded deterministic workflow prefix without credentials; replay failure is not a reproduced product defect.

Secrets must never enter model input, saved steps, screenshots of login entry, logs, exports, or browser localStorage. Transient password input stays in server memory only as long as needed. Authenticate before starting evidence recorders/tracing, and clear bootstrap records. Native traces/HAR may still contain cookies and session headers after login: do not claim JSON redaction sanitizes them. Default to sanitized JSON and masked screenshots for authenticated pilot runs; only enable trace export if its secret handling has been verified. Otherwise disclose that authenticated trace capture is disabled. Keep private auth state outside report/export routes and Git.

Acceptance: unauthorized form submissions/autosave are blocked, approved searches work, denial does not create a defect, login succeeds deterministically, clean validation authenticates and restores prerequisites, and fake-secret tests confirm protection across artifacts.

## 4. Milestone B — A small working local control panel

Implement one documented startup command, preferably npm run ui, after installation. The ordinary user should not need to edit YAML to use a saved profile. Keep technical details behind an Advanced section.

Required workflow:

1. Choose a saved project or create a simple profile.
2. Check setup: show actionable readiness results.
3. Provide login for this run if required; do not save passwords by default.
4. Choose Demo mode or a configured live provider explicitly, scope, and small run limits.
5. Start safe QA, watch actual progress, and stop if needed.
6. Review results, evidence, and previous runs.

Use ordinary QA language: Checking setup, Signing in, Exploring, Reproducing issue, Reviewing evidence, Completed, Stopped, Failed. Show pages visited, executed/skipped workflows, elapsed time, remaining limits when known, unique reportable issues, and issues needing review. No fake percent-complete based on an unknown discovery denominator.

Read structured events from the engine, using polling or SSE. Start supports one active run initially; duplicate clicks cannot launch duplicate jobs. Stop must work during exploration, validation, and model calls through cancellation/deadlines, bounded cleanup, and closing owned browser sessions. Save an explicitly partial/cancelled report. Never mark cancellation successful completion. Refresh/reconnecting the UI must not start another run. After server restart, prior active runs become interrupted unless actual recovery is implemented. Do not show Pause/Resume unless those semantics are fully built and tested.

Results show grouped issue cards with expected/actual behavior, reproduction successes/attempts, evidence completeness, critic outcome, and related manifestations. Separate Reportable issues, Needs review, Suppressed, and Not reproduced. Validated means reproduced; it does not automatically mean confirmed product defect. Keep raw findings and original machine decisions accessible for audit. Existing group-enabled fixture runs should display the canonical count, not a misleading raw count.

Show readable error and empty states. Zero issues means no reportable issues found within this run's scope, not the website has no bugs. Unsupported capabilities must not appear as working checkboxes.

Serve on loopback only. Validate request schemas, Host/Origin and state-changing request tokens; do not enable wildcard CORS or rely on localhost binding alone. Keep credentials server-side. Resolve artifact routes through registered run IDs and approved paths, rejecting traversal/symlink escapes. Escape captured application text and render no untrusted HTML. Do not expose .env, auth state, arbitrary filesystem paths, or arbitrary shell commands through the UI. Add basic keyboard access, labels, focus handling, and visible status/error messages.

Acceptance: a person can run the fixture from the UI, view correct grouped results/evidence, reopen a prior run, receive useful setup errors, and cancel without orphaning owned processes. UI and CLI share report semantics.

## 5. Milestone C — One real-application pilot

Default target: a dedicated self-hosted OrangeHRM instance with synthetic data, reflecting my earlier project direction. Use an existing explicitly owned sandbox if one is already configured. A public hosted demo is not a substitute for permission to test it. Never fall back to opensource-demo.orangehrmlive.com or a random public website.

Inspect current official installation guidance before selecting a setup:
- https://github.com/orangehrm/orangehrm
- https://github.com/orangehrm/orangehrm-os-dev-environment
- https://playwright.dev/docs/auth

Pin the application version/revision and document the runtime, installation method, seed data, test account role, and non-secret target URL. Use only the dedicated services needed for one instance; do not start an entire multi-version development matrix or delete unrelated Docker volumes. Keep target source/data separate from AutoQA. If Docker or OS setup requires unavailable privileges, finish the integration and setup instructions, identify the exact prerequisite, and mark live pilot acceptance pending. Do not claim an unavailable app was tested.

Start with login plus dashboard, then expand to three to five actual available pages, such as employee list, directory, or leave list. Aim for five to ten verified safe workflows: navigation, search, empty-result handling, pagination, filtering, sorting, and reload where supported. Discover what actually exists; report missing modules as unavailable, not defects. Use at most a few bounded runs and record why any rerun was needed. Do not measure success by finding a required number of bugs.

Tune navigation, waits, and locators only when the pilot demonstrates a problem. Prefer semantic readiness over arbitrary sleeps. Repeated action failures need bounded retry/quarantine and visible coverage loss instead of consuming the whole run on one candidate. Report unsupported flows separately. Pilot coverage refers to declared workflows and discovered pages, never total product coverage.

Use the existing fixture as a positive control for detection/reproduction/grouping. On unmodified OrangeHRM, zero genuine findings is valid. If a controlled fault is useful for an additional integration check, isolate it in a local test-only variant and label it injected; never present it as an upstream product bug or modify runtime logic using evaluator labels.

Record target/version, profile, actual pages/workflows, observed failures, replay outcomes, grouped findings, human-review state, duration, and limits. Without an independently labeled defect dataset, show recall/F1 and dataset-level precision as N/A. A human acceptance fraction among reviewed reports must have its own name, denominator, unresolved count, and coverage of the review sample. Never load the fixture ground truth to score OrangeHRM.

Acceptance: preflight, deterministic login, safe exploration, authenticated fresh-context replay, and report delivery work on the actual local application. Demonstrate replay with a real captured issue if available; otherwise use a clearly labeled controlled scenario in addition to the ordinary pilot. Distinguish application integration, actual model use, and actual defect discovery in the handoff.

## 6. Milestone D — Bounded live use, usage accounting, and human triage

### D1. Usage and live model execution

Instrument actual provider request attempts, success/failure, latency, input/output token usage when returned, and repair/retry calls for existing Anthropic/Explabs paths. Disable hidden SDK retries or account for them through a bounded mechanism. Use the same timeout/cancellation/request-budget controls in experiment conditions and ordinary runs: current src/experiments/conditions.ts calls critique directly, so sharing buildCriticInput/decideDisposition alone does not guarantee budget parity.

Run-level and UI summaries must distinguish measured values, estimates, and unavailable values. Unknown token usage is null; measured request count and elapsed time should be real. Calculate estimated dollars only from explicit verified pricing metadata with its source/date and token categories. If pricing is unknown, enforce request/time/output limits and say monetary cost cannot be guaranteed. Do not display a hard dollar cap unless the implementation can enforce it.

No live requests during unit tests, setup checks, or default fixture acceptance. A user selecting a configured live mode and starting a run is the explicit live action; show provider/model and limits beforehand. While implementing, do not use existing keys for paid requests unless that run's limits have been explicitly authorized. Prepare everything else without waiting for credentials.

For a first authorized live pilot, use conservative explicit limits (for example 5 minutes, 40 browser actions, 5 pages, 12 Explorer requests and 6 Critic requests, including repairs/retries). Smaller budgets may yield partial coverage, which must be disclosed. Stop cleanly on authorization failures or persistent rate limiting; no retry storms and no silent mock fallback.

One working live provider is enough for an initial integration pilot. A second provider is not mandatory here. If cross-provider testing is later authorized, validate resolved runtime identities, including auto resolution; two keys through Explabs remain the same gateway. Label same-model, different-model/same-gateway, and different-provider conditions accurately. Offline replay with a live critic still makes paid requests; preserve that distinction and reject integrity failures before provider calls. Do not promise byte-identical output from stochastic live models.

### D2. Human review usable without fixture ground truth

Reuse Phase 3 human-review tooling, but fix assumptions before applying it to real targets. src/human-review/import-cli.ts currently unconditionally loads fixture/ground-truth.json. Make ground truth explicitly optional and dataset-specific; absence means no agreement-with-ground-truth score.

The current boolean conversion treats unsure as not-defect. Preserve unsure as abstention, report it separately, and exclude it from binary correctness scoring with clear denominators. Reject unknown item IDs, mismatched export IDs, and conflicting duplicate labels from the same rater/item. Repeat submissions by one person must not inflate independent rater counts.

Add simple manual labels to issue review: Defect, Expected behavior, Unsure, with notes. Save human labels separately from immutable machine decisions and preserve original benchmark results. Ordinary triage shows machine outcomes; a separate blind review mode/export must hide them, ground truth, and answer-bearing mapping files, including API responses/artifact filenames exposed to the rater. Make sanitized evidence actually reachable from opaque review items.

Request a real human review only after a concrete usable review set exists. Never supply human labels yourself or invent rater participation. With one rater, report reviewed count/acceptance/uncertainty; with two independent raters over common items, label raw agreement correctly and compute chance-corrected agreement only if implemented with its assumptions. No rater means ready for review, not study completed.

## 7. Verification and completion requirements

Test behaviors that matter: default test discovery before/after build; denied implicit submission/autosave; allowed read-only search; auth failure/success/expiry; fresh authenticated validation and prerequisites; incorrect error-signature reproduction; cancellation and cleanup; actual provider budgets and retries using fake clients; profile validation; UI start/progress/stop/reload; artifact traversal and untrusted-text handling; fake-secret leakage including native evidence where enabled; real-target metrics without ground truth; human unsure/duplicate-label handling; and fixture regressions.

Run relevant targeted tests during changes, then typecheck, full tests, build, provider configuration check without live calls, mock QA/benchmark, Phase 3 capture/replay, corpus validation, and new UI end-to-end checks as appropriate. Validate default npm test again after build. Do not count compiled duplicates as extra coverage. Run the real pilot only on the authorized local target and label live-model execution separately.

Write docs/PHASE4_ACCEPTANCE.md with actual commands, run IDs, artifacts, target revision, coverage, mock/live distinctions, user-flow screenshots, and limitations. Update README.md/PROGRESS.md, removing stale Phase-1 completion messages and contradictory current test/dependency statements while retaining labeled history. Include a short QUICKSTART.md: install once, launch control panel, run demo, prepare local OrangeHRM, select login/scope, run, review results, and stop services owned by this project.

Suggested completion checks:

- Normal tests pass before and after build; existing user dependency changes are preserved or explicitly reconciled.
- A saved profile is runnable without editing YAML; the demo works without API keys.
- Local UI launches with one command, shows actual progress/results, and cancels reliably.
- Real-target actions and requests obey explicit policy in exploration and validation.
- Login/bootstrap and clean authenticated replay work; credentials are absent from model context and exported evidence.
- A three-to-five-page real-app pilot is executed where available; every skipped acceptance item has a precise reason.
- Request/time accounting is measured, unknown pricing/usage is explicit, and all live requests require explicit run selection/authorization.
- Human review works without fixture ground truth, retains abstentions, and distinguishes prepared tooling from actual human participation.
- Existing fixture results and immutable research artifacts remain auditable.

External dependencies do not justify stopping all work: complete independent engine/UI/tests, then mark unavailable real-app/live-model/human acceptance items pending. Do not call the entire phase complete if required real-application acceptance has not run. No arbitrary bug-count, precision, or perfect-score target is required for pilot success.

Final handoff: completed/partial/blocked milestones; working startup command and local URL; actual target/version and pages/workflows; original versus current test results; defects versus tool/environment failures; mock/live model status and measured usage; human review status; artifact/file paths; existing changes preserved; limitations and next phase; and confirmation of no push, PR, or GitHub writes.
ent working tree and repairing test discovery. Then implement action safety/authentication, the thin local UI, and the real-application pilot in that order, integrating telemetry and human review before final acceptance.
Begin by inspecting the curr
