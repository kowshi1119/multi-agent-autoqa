# Ajeer pilot report — Phases 5–6

**Ajeer live acceptance: pending.** This report separates offline implementation verification, read-only browser discovery, and AutoQA execution evidence. It makes no live-model performance claim.

## Phase 6 continuation — 2026-09-18

A fresh source/configuration audit and read-only preflight confirm that the existing runner is usable, but authenticated acceptance remains pending. Both providers were explicitly verified as mock before the probe; the target and local UI responded HTTP 200. Readiness correctly fails because the authenticated URL/signal are still unverified. The private manifest remains empty. Browser-session inspection failed to initialize because of a Windows sandbox error; no authenticated observation was obtained from the user.

**New Ajeer AutoQA run IDs: none. Workflow outcomes: none. Repeatability: not demonstrated.** The only historical Ajeer run remains the failed run below. No production source/configuration changes, additional login attempts or live provider calls were justified. One offline preflight test was corrected after a startup-time assertion failed; it now directly verifies that no network probe occurs. Private profile and manifest values are retained until observation supports an update. Existing standalone browser reports are not AutoQA acceptance evidence.

Current sanitized setup evidence: [PHASE6_READINESS.json](docs/PHASE6_READINESS.json). Acceptance matrix, verification, resumption steps and separate unexecuted Gemini proposal: [PHASE6_ACCEPTANCE.md](PHASE6_ACCEPTANCE.md). Phase 5 implementation verification below remains historical; the Phase 6 record identifies checks rerun now.

## What AutoQA actually executed on Ajeer

No new authenticated Ajeer run or business workflow was executed in this implementation session. No sandbox credentials were supplied through the transient local UI. Unsolicited chat credentials were not used or copied into artifacts. Authentication success checks remain unobserved and intentionally fail readiness; an empty manifest does not count as coverage.

The existing run `RUN-20260916-121442769Z-0b77` was inspected without altering its evidence:

| Measure | Historical result |
|---|---|
| Authentication | Failed: success URL mismatch after two attempts |
| Run status | Failed |
| Recorded exploration actions | 0 |
| Explorer calls | 0 |
| Provider requests | Explorer 0; Critic 0 |
| Pages visited / findings | 0 / 0 |
| Elapsed run time | 45,392 ms |
| Workflow completion / repeatability | Not demonstrated |

The old action counter excluded login operations, so zero recorded exploration actions must not be read as zero authentication operations. That run is **not a successful pilot**.

## New observations, separate from acceptance

- Guarded Chromium discovery reached `/login` from the root and observed email/password inputs and the Login submit button. No credentials were entered. The page attempted POST logout and client-token requests; policy denied them in this unauthenticated discovery session. See `docs/AJEER_DISCOVERY.json`.
- `npm run doctor -- --profile ajeer` resolved mock Explorer and mock Critic, launched Chromium, passed scope/schema checks, and received HTTP 200 from the target probe. It returned **NOT READY**, exit 1, because authenticated URL/signal checks are unverified. Reachability is not authenticated access.
- No additional origin or mutation was authorized. The previously known three login endpoints were moved from the global form allowlist to exact authentication-lifecycle exceptions.

## Implementation and offline evidence

The generic declared-workflow path now runs through AutoQA's own planner, mock Explorer, FSM, action policy/executor, deterministic assertions, recorder and reporting. It is not a separate Playwright script presented as a pilot. Browser-assisted discovery remains explicitly labeled.

Offline Chromium tests use synthetic local servers marked `owned-sandbox` with fake credentials, retaining real-target policy. They verify successful auth-only execution, SPA control completion, assertion failure, blocked POSTs with zero mutation hits, bounded unsuccessful candidates, cancellation, deadlines, action/page budgets, session expiry, unsupported declarations, evidence validation/redaction and derived-report preservation. The UI regression starts a selected workflow and records an annotation through the actual local application.

Final verification: `npm run typecheck` and `npm run build` passed; `npm test` passed **598 tests across 70 files** in 218.64 seconds. This adds 18 regression tests to the current 580-test baseline. The built UI returned HTTP 200 with the new controls. Detailed acceptance boundaries are recorded in `PHASE5_ACCEPTANCE.md`.

## Requested sequential acceptance

| Stage | Status | Missing evidence |
|---|---|---|
| 1. Authentication only | Pending | Observed success URL/signal, transient credentials, successful AutoQA run |
| 2. One read-only workflow | Pending | First observed declaration and passing assertion evidence |
| 3. Remaining approved workflows | Pending | Total of 3–5 observed workflows and individual outcomes |
| 4. Repeat completed workflow | Pending | A separate run demonstrating repeatability |

The private manifest is intentionally empty. No landing-page feature, list, search, filter, detail view, expected balance or API behavior has been invented. Unsupported observations and application-versus-runner assertion failures remain review items; they are not automatically defects.

## Findings and review

No new Ajeer anomalies, validated findings, groups or Critic dispositions were produced. No human triage or independent reference labels were supplied. Precision, recall and F1 are **N/A**. Mock Critic is not independent human verification; existing fixture metrics remain fixture metrics.

## Next user action

Start `npm run ui` and use the dedicated sandbox account under user control to identify the authenticated landing URL and an exact visible authenticated-page signal. Update those non-secret profile fields and set `checksVerified: true` only after observation. Enter credentials only in the local UI, choose Demo/mock and Authentication only, then Start. After successful AutoQA authentication evidence, define and run the observed read-only workflows in the sequence above. Do not send credentials in chat.

The detailed user guide, manifest example, counters and limitations are in `docs/AJEER_PILOT_SETUP.md`. Ajeer profile and manifest remain intentionally Git-ignored; no secrets or browser authentication state were persisted. No commits, pushes, PRs or deployments occurred. OrangeHRM and live-provider evaluation remain deferred.
