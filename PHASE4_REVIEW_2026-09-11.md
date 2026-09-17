# Independent Phase 4 review — 11 September 2026

Phase 4 has made substantial progress, but it does not yet meet its own completion requirements. The appropriate status is **implemented in part, with safety/reliability fixes and real-application acceptance still pending**. Keep the present architecture; close these gaps before expanding scope.

## Scope and verification

Reviewed the uploaded completion report and the local working tree at HEAD `17b6aa9`, including its uncommitted continuation changes. This was a local code review, not a fresh GitHub audit. No implementation, private profile, credential, or historical run artifact was edited. No staging, commit, push, PR, or live provider request was performed. Build/test output and isolated temporary probe artifacts were generated.

Independent results:

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: **59 files passed, 1 failed; 469 tests passed, 1 failed, 470 total**. The failure was `listen EADDRINUSE: address already in use ::1:4173` in the reporting assembly fixture test. Duration: 144.37 seconds.
- Targeted rerun `npm test -- tests/reporting/assemble.test.ts`: **3/3 passed**, duration 42.60 seconds. Its fixture assertions verify 9 validated findings, detection precision approximately 0.667 / recall 1.0, and final-report precision 0.75. This does not convert the failed full-suite run into a clean pass. The process occupying 4173 was no longer present when checked; its identity was not established.
- Isolated probes used fake request/browser/run execution and a fake credential. They confirmed the policy, redaction, concurrency, and preflight findings below. They did not contact any website or provider.
- The rendered dashboard was not manually retested in this review. The handoff's manual UI results remain author-reported evidence. OrangeHRM acceptance remains pending in the project's own documentation.

## What improved

The shared pipeline and report assembly remain useful architectural choices. Provider request accounting now sits around each SDK request, including repair calls; mock providers do not add network requests. SDK retries are disabled in the inspected adapters. Timeout/Stop signals reach provider requests. Authentication now precedes recorder attachment, and form login checks both its URL condition and authenticated-page signal. Completely blocked reproduction attempts now remain `needs_human`. Fixture oracle configuration parity, dashboard progress recovery, evidence links, and pilot-summary wiring have been added.

These improvements deserve to be retained. However, fixture success provides limited evidence for real-target safety because fixture profiles deliberately bypass the real-target ActionPolicy.

## Findings requiring correction

### 1. P1 — Real-target request policy is skipped for document navigations

[Navigation guard](<C:/Users/ADMIN/Desktop/multi auto QA/src/safety/navigation-guard.ts:64>) checks navigation requests for origin, then invokes the resource policy only in an `else if`. A same-origin document request therefore never receives the method/endpoint policy. [ActionPolicy](<C:/Users/ADMIN/Desktop/multi auto QA/src/safety/action-policy.ts:164>) also exempts `document` requests as assets.

A fake-route probe submitted an unapproved same-origin `POST /admin/delete-record`: **policy calls 0, continued 1, aborted 0**. A separate probe showed direct navigation to `GET /admin/delete-record` allowed while the fetch-shaped version was denied. This matters for forms or page scripts that navigate to a mutation endpoint, and for destructive GET links that the planner can offer as navigation candidates. Same-origin redirects also lack a path-scope check at the route boundary.

Other confirmed policy gaps: unknown in-scope fills are allowed, and direct navigate actions remain allowed with an empty workflow allowlist. A click on a link is checked differently from navigation to the same link. The planner still does not consume the profile's full path/workflow policy.

Required fix: apply an operation-aware policy consistently to candidate generation, action execution, navigation/redirect requests, and replay. Preserve narrowly scoped authentication exceptions. Treat documents separately from static assets. Verify prohibited requests never reach a local test server, including redirects, native forms, and JavaScript navigation.

### 2. P1 — Transient secrets can still reach prompts and reports through URLs/metadata

[Observation](<C:/Users/ADMIN/Desktop/multi auto QA/src/browser/observation.ts:324>) redacts visible text but returns the original page URL, title, structure, and recorded network URLs. [Explorer prompt formatting](<C:/Users/ADMIN/Desktop/multi auto QA/src/explorer.ts:70>) includes the original page URL. [Report JSON writing](<C:/Users/ADMIN/Desktop/multi auto QA/src/reporting/qa-report.ts:64>) serializes data without its own redaction boundary.

An isolated fake-page probe supplied a known fake transient credential both in visible text and a URL query value. Visible text was redacted, but the observation URL, network metadata, and formatted provider prompt still contained the credential. Passing those fields to the report writer preserved it there as well. No real secret was used, and no prompt was sent to a provider.

Required fix: maintain raw browser execution state separately from sanitized model/export data. Scrub every outgoing prompt, report, event, and evidence representation using the run's credential set, including URL encodings and metadata. Do not simply redact operational URLs and then navigate using the redacted value. Native screenshots/traces need their own explicit exposure policy; text replacement does not sanitize them.

### 3. P1 — Phase 2 CLI still bypasses explicit live authorization

[Phase 2 argument parsing](<C:/Users/ADMIN/Desktop/multi auto QA/src/phase2-experiment.ts:22>) defaults to `qa.config.yaml`, whose Explorer is currently Explabs. Its [pipeline call](<C:/Users/ADMIN/Desktop/multi auto QA/src/phase2-experiment.ts:168>) omits `requireLiveAuthorization`; the shared pipeline checks authorization only when that option is supplied.

Consequently, `npm run experiment:phase2` can still reach a live Explorer using an existing credential without `--live`. This is established by code inspection; the command was deliberately not executed. Condition B itself uses a mock critic, which does not protect Condition A's Explorer.

Required fix: cover every executable entry point with a no-network regression test. Prefer an explicit authorization context whose absence denies live requests, so a forgotten optional argument cannot reopen this issue.

### 4. P1 — Request limits count decisions, not every billable attempt

The handoff correctly discloses this remaining gap. The [orchestrator](<C:/Users/ADMIN/Desktop/multi auto QA/src/orchestrator/orchestrator.ts:299>) records one model call per logical decision, while the [provider](<C:/Users/ADMIN/Desktop/multi auto QA/src/models/provider-implementation.ts:95>) can issue a second repair request internally. Critic repairs have the same problem.

A limit of one logical call can therefore permit two actual requests. Measuring those requests afterward does not enforce the displayed cap. This was explicitly required by the continuation prompt, so D1 should not be marked fully complete.

Required fix: reserve budget at the actual request boundary before both initial and repair attempts; distinguish logical decisions from HTTP attempts in reporting. Use the lesser of the request timeout and remaining run deadline. Test a one-request budget with deliberately invalid first output and verify no second request starts.

### 5. P1 — Simultaneous starts bypass the single-active-run guarantee

[RunManager](<C:/Users/ADMIN/Desktop/multi auto QA/src/run-manager.ts:130>) checks `this.current`, then awaits preflight at line 151, and only assigns `this.current` at line 175. Two calls arriving during that await both pass the initial check.

With fake browser preflight and fake run execution, two simultaneous starts both fulfilled and invoked execution twice. Only one active run remained tracked. In the probe, second-resolution run IDs also collided, compounding the risk of shared artifact directories. Real outcomes can include competing browsers/fixture ports, hidden work, overlapping live spending, and Stop controlling only one execution.

Required fix: reserve a starting/running slot synchronously before the first await, release it on failure, and generate collision-resistant run IDs. Test concurrent start requests: one accepted, one rejected, one execution, distinct historical artifact identities.

### 6. P1 — Preflight probes targets before checking authorization scope

[Preflight ordering](<C:/Users/ADMIN/Desktop/multi auto QA/src/preflight/doctor.ts:197>) awaits reachability before checking scope consistency. Its [fetch](<C:/Users/ADMIN/Desktop/multi auto QA/src/preflight/doctor.ts:80>) also follows redirects by default without checking each destination.

A fake-transport probe recorded a request to `http://unapproved.invalid/admin` before the result reported scope failure. There was no actual network request in this probe.

Required fix: validate scheme, origin, path, and authorized target first; then probe within that scope. Reject out-of-scope redirects before following them. Test that both invalid initial targets and invalid redirect destinations cause zero requests to the disallowed endpoint.

### 7. P2 — Replay evidence boundaries and incomplete attempts need tightening

[Validator](<C:/Users/ADMIN/Desktop/multi auto QA/src/validator.ts:238>) takes its `before` observation before replaying prerequisites, then runs prerequisites and triggering steps in one loop. Errors produced during setup therefore enter the same before/after comparison as errors produced by the actual trigger. This creates a false-attribution risk when a prerequisite produces the original failure signature. This observation comes from source review, not a reproduced live-application false report.

The [prerequisite selector](<C:/Users/ADMIN/Desktop/multi auto QA/src/orchestrator/orchestrator.ts:401>) takes the last eight history entries. History includes failed/blocked actions, and the tail need not begin at a restorable page/state. It is not yet a verified workflow prerequisite sequence.

A separate deterministic probe confirmed `decideStatus(0, 1, 2)` returns `rejected`. If other attempts were blocked or cancelled, that can reject a finding after only one valid negative attempt despite the continuation requirement to retain inconclusive status when too few valid attempts remain. `minimumSuccesses` alone is not an explicit negative-evidence threshold.

Required fix: restore and verify prerequisites from an explicit anchor, then capture the baseline and replay the trigger. Keep unsupported restoration inconclusive. Define both positive and negative evidence requirements and test mixed negative/blocked/cancelled outcomes.

### 8. P2 — Stop and failed-report accounting are not complete across the lifecycle

[Form login](<C:/Users/ADMIN/Desktop/multi auto QA/src/auth/session-bootstrap.ts:46>) accepts no cancellation signal. Its multiple waits and authentication retries can continue after Stop. Provider transport cancellation is an improvement, but it does not establish the requested short bound for login/browser/replay cancellation.

[RunManager's catch path](<C:/Users/ADMIN/Desktop/multi auto QA/src/run-manager.ts:262>) also writes zero requests, zero cost, and a claim that no request was attempted for any exception in execution/report assembly. An assembly or cleanup failure after real calls would make that claim false. This is a source-confirmed exceptional-path problem, not a real billing incident observed during this review.

Required fix: carry Stop and remaining deadlines through authentication and replay, stop starting subsequent steps/retries, and preserve known usage/finding state when reporting fails. Unknown cost must remain unknown.

### 9. P2 — Default test suite still depends on fixed ports

The failed [reporting test](<C:/Users/ADMIN/Desktop/multi auto QA/tests/reporting/assemble.test.ts:27>) loads the mock configuration's fixed port 4173. Several newer tests also use different fixed ports. Avoiding collisions by allocating a different hardcoded number per file does not isolate tests from other local processes or concurrent runs.

Required fix: use OS-assigned ports and propagate the actual bound URL into test configuration, with reliable teardown. Preserve the distinction between the failed full run and the passing isolated rerun; do not hide the failure with a blanket green statement.

## Required work still omitted or externally pending

The acceptance document itself acknowledges no profile create/edit UI, no declared business-workflow manifest, no live OrangeHRM pilot, and no actual independent human-review exercise. A generated pilot-summary file and synthetic adapter tests do not establish real-application acceptance.

The original continuation explicitly requested profile creation/editing, per-request reservations, bounded cancellation, and real-app acceptance. Moving these to Phase 5 is a scope change requiring an explicit decision; disclosure alone does not complete them.

No verified price table is a reasonable limitation: keep cost unknown where it cannot be computed honestly. An unavailable second live provider should also remain unavailable. Neither should lead to invented prices or fabricated research comparisons.

## Recommended next step

Close the safety, redaction, authorization, budget, and run-lifecycle defects first. Then complete profile creation and a small declared workflow manifest. Run one controlled, owned/self-hosted real application with disposable data and explicit scope: login, three to five pages, and five to ten safe workflows. Record attempted/completed/blocked/unsupported workflows separately from heuristic counts and confirmed findings; retain reproducible evidence and human dispositions.

Do not add more providers, autonomous agents, a larger dashboard, or broader website coverage to compensate for these acceptance gaps. Current fixture precision/recall is useful regression evidence, but does not measure defect recall on arbitrary websites, where the total number of unknown defects is not established.

Suggested milestone wording: **Phase 4 continuation implemented; independent review found outstanding safety/reliability defects; real-application acceptance pending.**
