# Phase 6 acceptance — authenticated Ajeer sandbox pilot

## Current checkpoint — 2026-09-23

**Live acceptance remains pending.** This checkpoint supersedes historical setup claims below. The private profile has saved conditions and checksVerified=true, but no successful AutoQA authentication evidence and no declared workflows. An earlier discovery suggestion derived a banner name from descendant text; synthetic reproduction confirmed such a locator can match zero elements. Rediscover and confirm a stable heading locally.

Discovery now validates unique visible accessible locators, requires an in-scope changed route and a signal absent on login, strips URL query/fragment, closes on Cancel/disconnect/deadline, and rejects overlapping sessions. It retains exact request exceptions and records no screenshots, traces or browser sessions. A separate normal authentication run remains required. Another reproduced failure occurred after successful login: redaction consumed a closing JSON quote in a token-bearing URL and broke report assembly. Delimiter handling is fixed; authentication evidence now saves only origin/path. The synthetic UI regression covers discovery, confirmation, auth-only success, saved reports, Cancel and CSRF.

Verification: **npm run verify:local** passed typecheck/build, **642 tests / 76 files (371.20s)**, and corpus validation (20 cases: 12 distinct defects/8 non-defects, 7 executable/13 offline). Final UI-label and exact-origin changes passed **11 targeted tests / 3 files (21.45s)**. Earlier failing suites remain historical failures, not retrospectively green.

Actual UI completion: **RUN-20260923-053522611Z-68e9**, 74 actions, 38 mock decisions, 6 pages. Separate Stop: **RUN-20260923-053605943Z-cda9**, cancelled after 3 actions/2 decisions, with Start usable afterward. Evidence links returned HTTP 200. Both roles made zero external provider requests. Desktop 1365px and narrow 390px screenshots were visually checked; narrow layout had no horizontal overflow. Canonical six-defect fixture matcher: 6 true positives, 3 false positives, no false negatives; precision 0.667/recall 1.0/F1 0.8. Nine findings reproduced, with eight report dispositions and one suppressed. These raw canonical metrics are separate from duplicate grouping/final dispositions.

Four frozen mock decision cases passed; the existing always-stop regression separates structural validity from useful progress. Corpus labels, matcher and thresholds were unchanged. No actual hosted/local inference, installation or model download occurred. Ollama inventory availability is checked with bounded time/size and manual redirects; inference quality and runtime cloud settings remain unverified. Ajeer metrics remain N/A.

The updated panel was started at http://127.0.0.1:4181/. User-controlled local entry was requested once; no chat credentials were used and no new Ajeer login was attempted. Next action: Ajeer → Demo → Discover → confirm stable heading/exact URL → Authentication only with fresh local entry. After normal authentication succeeds, observe and declare 3–5 real read-only workflows, run them sequentially, and repeat one in a fresh run. Existing scope/budgets remain unchanged. The pre-existing deletion of AJEER_PILOT_REPORT.md is preserved outside this commit.

## Historical checkpoint — 2026-09-18

Date: 2026-09-18. **Live acceptance pending; not accepted.** Independent verification and acceptance documentation are complete. The Phase 5 runner is reused without production source changes. One preflight regression assertion was corrected as described below.

## Current evidence

The current private profile and workflow manifest were parsed through the production loaders. Explorer and enabled Critic both resolve to mock. Authentication checks remain unverified, and the manifest contains zero workflows. The local UI responds with HTTP 200 at http://127.0.0.1:4180/. A single read-only preflight probe received HTTP 200 from Ajeer and successfully launched Chromium, but correctly returned NOT READY for unverified authentication conditions. The sanitized record is [docs/PHASE6_READINESS.json](docs/PHASE6_READINESS.json); this is setup evidence, not an authenticated AutoQA run.

Browser-assisted observation of the existing session was unavailable: the CUA runtime failed to initialize with a Windows sandbox ACL error. This is a browser-tool environment failure, not an Ajeer defect. User assistance was requested for the final URL and exact visible authenticated heading/landmark. Those observations have not been received. Chat-supplied credentials were not used, retrieved from earlier messages, copied to files, or supplied to tools. Local credentials, cookies, storage and personal/financial content were not inspected.

The complete scan of top-level run-summary.json files for the target origin found only the historical run RUN-20260916-121442769Z-0b77. It failed authentication; zero recorded exploration actions, model calls, provider requests, pages visited and findings do not demonstrate acceptance. Its legacy action count excludes authentication operations. Original run evidence is unchanged.

## Acceptance matrix

| Requirement | Result | Evidence or missing condition |
|---|---|---|
| Explicit mock Explorer and Critic | Verified for readiness; verify again before each future run | PHASE6_READINESS.json providers |
| Observed authenticated URL and specific signal | Blocked by missing observation | No values guessed; checksVerified remains false |
| Successful AutoQA auth smoke | Pending; no new run ID | Requires observed checks and local transient credential input |
| Three to five observed safe workflows | Pending; zero declared | Authenticated pages and controls not observed |
| First and remaining workflow runs | Pending; no outcomes manufactured | No executable declarations yet |
| Fresh repetition of a completed workflow | Pending | No completed workflow to repeat |
| Evidence integrity | Preserved for existing evidence | New live workflow evidence unavailable |
| Types, build, offline regressions | See verification below | Cannot substitute for live acceptance |

No new Ajeer authentication attempt, workflow run, browser discovery session, or live provider call was made in Phase 6. The only new target interaction was the preflight reachability probe. Workflow statuses are therefore not invented: no runner workflow exists to annotate as completed, blocked, unsupported or failed. The acceptance stage itself is blocked. Ajeer precision, recall and F1 remain N/A because no independent ground truth exists.

## Verified implementation boundary

Reviewed the existing RunManager → runPipeline → authentication/planner/executor/reporting path. Demo forces both providers to mock before preflight. Authentication-only uses that same pipeline. Login requires both URL and visible signal; checksVerified=false fails readiness before login. Login retries remain bounded to two, with no retry for missing credentials/configuration, Stop or exhausted budget. Existing offline tests cover false URL/signal success, cancellation, deadline interruption, session expiry, bounded retries, assertion failures, action accounting and denied mutations.

No compatibility failure requiring an engine change has been demonstrated. No production source changes or additional test cases were added; one existing regression was strengthened after its timing assertion failed. The private profile and manifest are deliberately preserved rather than populated with unobserved selectors. Exact authentication POST exceptions and all configured limits remain unchanged: 25 actions, 20 model calls, 5 pages, 5 findings, 5 Critic calls, 180 seconds. Authentication is not recorded; authenticated traces remain off. Existing screenshot restrictions remain in force. No paid requests, staging, commits, pushes, PRs or deployments occurred.

## Verification

Previously reported Phase 5 baseline: 598 tests / 70 files, typecheck and build passing. The first Phase 6 typecheck and build passed. The first full suite completed with 597 passing tests and one failure in tests/preflight/doctor.test.ts (247.71 seconds): the whole preflight took 1,938 ms against a less-than-1,000 ms expectation. That duration includes Chromium startup and does not establish whether a network probe occurred. The existing regression now directly spies on fetch and requires zero calls, while retaining managed-target and readiness assertions and restoring the spy in finally. This strengthens the intended no-network contract without relaxing production behavior or timeouts. Test count remains 598. The targeted preflight suite passed all 10 tests (9.67 seconds). Typecheck and build passed again, and the final Phase 6 suite passed all 598 tests across 70 files (219.57 seconds). These results are from 2026-09-18 and precede the separately added Ollama work. No live-model quality claim is made from mock or mocked-SDK tests.

## Resume sequence

1. Sign in to the Ajeer sandbox locally with the dedicated account. Supply only the final URL and an exact visible heading or navigation label. If browser inspection becomes available, use authorized read-only observation instead. Do not provide account credentials in chat.
2. Replace the profile's URL condition and visible signal from that observation, record the source, and set checksVerified=true. Preserve origin/request exceptions and limits. Do not disable the readiness gate.
3. In the local AutoQA UI, select Ajeer, Demo, Authentication only. Confirm both providers remain mock, enter credentials in Sign in for this run and press Start. Require successful authentication.json evidence before any workflow run. Each run needs its own transient credential input.
4. Inspect authenticated controls within the approved read-only scope. Declare 3–5 real workflows, documenting starting state, exact controls/inputs, observed expected result/source, deterministic assertion, required sanitized evidence, reset and limitations. If fewer exist, record the shortfall. No business data assumptions or persistent mutations.
5. Through the existing AutoQA UI run one workflow, then the remaining workflows, then one completed workflow again in a fresh run. Verify mock providers before each run. Record actual run IDs, immutable workflows/<id>.json step/assertion evidence, authentication.json, run-summary.json and pilot-summary.json. Use supported annotations for later review and pilot-summary.latest.json for the derived view; never rewrite original evidence.

## Optional Gemini validation proposal — not authorized or executed

This proposal is separate from Ajeer acceptance and remains deferred until the pilot is resolved and the user explicitly authorizes the provider request.

- Provider: Google Gemini Developer API through the existing GeminiModelProvider. Exact model: gemini-3.5-flash, the identifier currently configured in qa.config.gemini.yaml. Its current availability and price are not established by this configuration.
- Input: one synthetic ExplorerInput describing a fake local page at http://localhost:4173/ with a static heading, no forms, no account records, no history and only the stop candidate. Use the existing Explorer system prompt and formatter. No authenticated Ajeer content, screenshot, trace, credential, cookie, real name, balance or identifier is included.
- Limit: one decideNextAction invocation with a dedicated model-call budget of 2; at most 2 provider HTTP requests (initial plus one schema repair), no transport retries. One 30,000 ms timeout spans that decision including repair; no automatic rerun. Critic remains mock and is not invoked. This is a bounded adapter smoke proposal, not the broader qa.config.gemini.yaml exploration run.
- Data leaving the machine: the Explorer system prompt, fabricated page text/URL and metadata, fabricated stop candidate, response JSON schema and an optional repair instruction. The locally configured API credential is used only for the provider's authentication transport and is never added to prompt/artifact text.
- Expected response: a JSON object with candidateId equal to stop and string testingIntent and reason fields, accepted by the existing strict schema. It can demonstrate transport/structured-response compatibility only, not defect detection quality or independent Critic verification.
- Cost: unknown; do not assume a free tier or zero cost. A 2-request cap is not a monetary ceiling. Verify current model availability, billing/pricing and the applicable account terms before seeking authorization. Record real request/token usage and provider failures; do not invent price estimates.

At the Phase 6 check, provider:check --live supported Explabs only; the subsequent local-provider work adds Ollama support. Neither is a Gemini smoke command. No live command or request was issued for this proposal.
