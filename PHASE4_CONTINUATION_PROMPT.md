# AutoQA Phase 4 — Continuation and Acceptance Closure

You are the senior QA lead and implementation engineer continuing my existing AutoQA repository. Continue Phase 4 from the ACTUAL current working tree. Do not restart the project or begin Phase 5.

Read PHASE4_PROMPT.md for the original scope, then this continuation prompt, current source, PROGRESS.md, docs/PHASE4_ACCEPTANCE.md, QUICKSTART.md, and applicable repository instructions. Existing implementation is substantial; preserve it and fix concrete gaps. Treat documentation and previous chat claims as claims to verify, not proof.

## Ownership and execution rules

- I will commit manually. Do not run git add, git commit, git push, create a PR, change branches, or perform GitHub writes. Preserve the existing index, staged changes, unstaged changes, and untracked work. Do not reset/restore/stash user work. There is no commit-footer decision to resolve because you will not make commits.
- Implement and verify; do not stop after writing another plan. Keep a short checklist and continue through authorized work without seeking approval after every milestone.
- A planning/delegation tool is not a prerequisite. If an optional subagent cannot run, do the bounded planning or implementation directly. Follow any actual permission boundary; do not bypass it.
- Do not run paid model requests or test public third-party sites. Use mocks/fake transports and explicit mock configs during development. Existing keys in .env are not authorization for live requests.
- Keep the current architecture, local-only UI, provider interfaces, Validator, Critic, grouping, reports, and research artifacts. Avoid new infrastructure or an engine rewrite.

## Claude Code environment and project automation

Core principle: THE MODEL REASONS, CODE DECIDES. Development plugins help implement and verify AutoQA; they do not replace deterministic oracles, validation, evidence checks, or report-disposition policy.

Before editing implementation files:

1. Read CLAUDE.md and applicable AGENTS.md instructions if present, including relevant nested instructions.
2. Inspect project-level .claude/ configuration, including settings.json, skills/, hooks, agents/, and commands/, plus referenced project automation. Read only task-relevant configuration and do not print secrets or private settings. These paths are discovery targets, not claims that they exist.
3. Check which tools and plugins are actually enabled in this Claude Code session. Global/user-level tooling may exist even when .claude/ is absent. Record a short capability summary without credential values. Do not claim a plugin was used merely because it was mentioned in chat.
4. Reuse relevant existing skills, hooks, commands, and verification workflows. Do not install plugins, scaffold a new .claude/ setup, or recreate automation just to satisfy this section.
5. Recheck current Git status and the source findings below. The 2026-09-11 baseline is historical; skip gaps already fixed and avoid overwriting later work.

Use available tools according to their actual role:

- Playwright MCP, if enabled, can exercise AutoQA's local control panel and authorized test targets, inspect rendered behavior, and capture screenshots/evidence. Keep the product's existing direct Playwright execution architecture. A development MCP tool is not a reason to migrate the engine or let browser actions bypass target authorization, profile scope, redaction, or run limits.
- If an add-oracle skill exists, read and follow it when adding/changing an oracle. Keep detection deterministic, assign evidence strength in code, and add meaningful matching tests. No oracle may depend on LLM opinion or evaluator ground truth.
- If a safety-review workflow or agent exists, use it for changes to safety, authentication, orchestration, budgets, cancellation, or replay. Its review supplements code-level enforcement and tests. Optional delegation must not become a blocker; perform the review directly if the tool is unavailable.
- For evidence, redaction, grouping, and human-review changes, use relevant project workflows while preserving secret protection, reviewer blindness, immutable evidence, and evaluation isolation.
- Claude Code Setup is a configuration helper. Reuse its actual project outputs where present; do not rerun setup or assume it installed particular components.
- Task Observer, if installed and enabled, may record non-sensitive development corrections or repeated workflow patterns. Treat its suggestions as advisory. Never let generated memories/suggestions override project safety, deterministic validation, reproduction requirements, security rules, or my no-staging/no-commit/no-push instruction. Do not deliberately send credentials or private evidence into observer notes.

Do not disable, remove, or bypass hooks or security protections to make an action succeed. If a tool/hook blocks a necessary action, report the exact action and stated reason, seek a compliant alternative, and continue unaffected work. Existing authorized tasks do not need another confirmation merely because an optional skill suggests a routine workflow preference. Do not use an alternative tool to evade a denied permission.

Protected inputs and allowed outputs:

- Do not edit .env, real credential values, private user profiles, or seeded ground-truth answers unless I explicitly request that change. Use fake secrets in tests. Public example profiles and implementation/configuration files may be changed where the Phase 4 tasks below require it; preserve user-specific values.
- Preserve existing run directories, captured evidence, immutable manifests, and original machine decisions. Do not rewrite old results to improve metrics or remove inconvenient findings.
- Creating NEW isolated test/run artifacts, screenshots, reports, and temporary test fixtures is authorized as part of the verification required below. Keep them separate from historical evidence and out of Git staging. New triage labels remain separate from original machine decisions.
- Use relevant project verification commands after changes, with explicit mock configuration and no paid requests. A plugin, hook, observer, or reviewer cannot silently authorize live calls, real-site mutation, staging, commits, or publishing.

## Verified starting point

An independent review on 2026-09-11 found:

- HEAD remained 08138be, the final Phase 3 commit. Phase 4 code existed as staged, unstaged, and untracked changes.
- npm run typecheck passed.
- Default npm test passed 397 tests in 55 files. The original compiled-test discovery problem is repaired.
- Profiles/preflight, authentication, action policy, local HTTP UI, RunManager, report assembly, usage scaffolding, and human-review changes exist.
- The OrangeHRM pilot remains unexecuted. docker, php, and mysql were not found on PATH during review; the standard Docker CLI install path was also absent. Recheck current availability. Missing Docker alone is not proof every possible self-hosted/native/owned-sandbox route is impossible.

Do not redo working milestones. Begin with the gaps below. The review used source inspection and harmless fake-data probes, not real target mutation or paid calls.

## 1. Enforce profile policy before real-target acceptance

Confirmed: navigation.allowedPathPrefixes, resources.allowedApiOrigins, and workflows.allowedWorkflowKinds currently appear only in src/profiles/schema.ts, not their enforcement paths. profileToAppConfig drops them. ActionPolicy permits every action except certain form submits; its request classifier permits unapproved GETs and receives no request origin.

Direct fake probes returned allowed for an unknown plain button outside scope, an unknown fill outside scope, and GET /delete-record. These are policy gaps, not evidence that a real site was modified.

Make the declared scope executable in Planner generation, actual action execution, redirects/resource requests, authentication exceptions, and Validator replay. Carry the profile or a validated policy object through the shared execution path. Use full origin + normalized route + request method + control/form/workflow context where needed. Handle path boundaries correctly; a prefix for /admin must not accidentally include /administrator.

Explicitly classify approved read/navigation/search/filter/sort/pagination operations. Unknown controls, autosaving fields, implicit Enter submissions, ambiguous GET actions, and unapproved mutation endpoints must not become allowed merely because they are not submit buttons. Continue allowing necessary approved assets and read APIs; do not blanket-block useful reads or blanket-allow all same-origin requests. Block service workers or otherwise ensure the selected interception policy is actually enforced. Reject unsupported flows rather than loosening the policy.

Protect CLI real-target runs too: optional actionPolicy/sessionAuth parameters must not allow a non-fixture CLI target to bypass real-target safety. Preserve legacy fixture behavior through explicit fixture handling, never by relabeling a real target local-fixture.

Record policy-blocked traffic as tooling evidence, and prevent its resulting console/network errors from being reported as product defects. Cover delayed XHR/fetch denials, not just synchronous blocked clicks.

Acceptance: meaningful integration tests prove path/API-origin/workflow restrictions work; approved search works; unknown fills/clicks and unapproved GET mutations are denied; equivalent allowed pathnames on a different origin stay denied; replay enforces the same policy; blocked traffic creates no false product finding.

## 2. Correct authentication evidence boundaries and transient-secret handling

Confirmed: src/browser/browser.ts calls attachPageRecorders before ensureAuthenticated, despite documentation claiming the reverse. Move evidence recording until after successful bootstrap, or implement an equally reliable separation and discard all bootstrap records. Keep navigation/request guards active during authentication. Close failed bootstrap contexts reliably.

The UI passes input.credentials directly to RunManager. src/redact.ts recognizes QA_PASSWORD from process.env, not arbitrary UI-entered values. A fake transient password not stored in the environment remained unchanged when embedded in ordinary text passed to redactSecrets. Do not solve this by writing a user's password into global process.env.

Implement per-run secret redaction for supplied credentials and relevant session values before logs, model inputs, events, reports, or exported JSON are emitted. Test a fake password echoed in login/page console text, error messages, visible text, and URLs. Ensure no bootstrap secrets survive in evidence. Clear the password input after submission and transient references at completion/cancellation; do not persist them or place them in browser storage.

FormLoginBootstrap currently swallows successUrlPattern timeout and can return success based only on the visible signal. Enforce the configured success criteria, or define explicit alternative criteria in the schema; do not silently ignore one. Validate regex/config inputs and keep login attempts bounded across the run.

Keep authenticated native trace capture disabled unless its sensitive contents can be handled correctly. Screenshot masking is not trace/HAR sanitization. Update documentation to describe the implemented behavior, not the intended one.

Acceptance: login records cannot appear in final evidence; UI-only fake secrets are scrubbed without environment-variable tricks; failed/expired sessions cannot be mistaken for valid authentication; failed contexts close.

## 3. Finish provider authorization, actual request accounting, and Stop

The acceptance document discloses an accidental live call caused by a CLI command defaulting to qa.config.yaml. Preserve this disclosure, but do not infer HTTP 429 or zero cost from an earlier incident or from a short run; use actual recorded evidence or say unknown.

Add an explicit live-execution gate across all entry points: QA, benchmark, experiment capture, replay, diagnostics with live mode, and UI. Without deliberate live selection/authorization and bounded settings, no provider request can occur, even if .env contains real credentials. Replay of a live critic is still paid work. Do not silently substitute mock when live was requested. Tests must prove the gate using fake transports.

Confirmed: Explorer wraps decideNextAction in UsageTracker.recordAttempt. That method can internally call the API once and then again to repair JSON. Critic has the same logical-call boundary. The current counter therefore undercounts repairs and counts mock decisions as if they were actual network requests. The SDK clients also discard returned token usage.

Instrument at the actual SDK request boundary. Separate logical decisions, mock invocations, actual network attempts, and completed requests. Count every attempted request, including failed/repair calls; reserve budget before each request. Preserve returned token categories and report incomplete/unknown totals honestly. Mock-only runs have zero network requests. Disabling hidden SDK retries is useful but does not account for AutoQA's own repair request.

Confirmed: Stop checks AbortSignal between FSM states and validation attempts, while withTimeout only races a Promise. Provider calls do not receive the run cancellation signal; Explorer has no equivalent configured deadline in its call path.

Propagate cancellation and remaining deadlines through Explorer, Critic, authentication, browser operations, Validator, and SDK calls. A timeout must abort supported transport work, not leave it running after the UI says stopped. Stop must prevent new requests/repairs and close owned contexts after bounded cleanup. Preserve cancelled status and partial findings, and do not fabricate zero usage if a run fails while assembling reports after requests have already happened.

Persist measured experiment usage too, not just ordinary-run usage. Verify integrity before any replay request. Keep cost null when pricing is unverified; do not invent prices or claim an unenforceable dollar cap.

Acceptance: fake transports show initial+repair equals two requests; one-request budget blocks repair; mock network count is zero; Stop interrupts a hanging Explorer, Critic, and login/browser operation within a documented short bound; no later repair starts; cancelled/failed reports retain known usage.

## 4. Preserve inconclusive replay and support the chosen pilot's prerequisites

Confirmed: Validator records toolingBlocked on failed login/policy/execution, then still calls decideStatus(successes, minimumSuccesses). Zero successful attempts yield rejected even if no valid replay was executed. Metadata saying tooling-blocked does not fix that downstream rejection/suppression.

Represent blocked/incomplete/cancelled validation explicitly. If too few valid replay attempts remain, retain needs_human or a well-defined inconclusive outcome; do not count missing evaluation as evidence against the finding. Preserve rejected behavior when adequate replay actually executes and does not reproduce. Test mixtures of successful, non-reproducing, blocked, and cancelled attempts.

The original Phase 4 spec required bounded workflow prerequisites, but the handoff deferred them. Implement only what the selected pilot needs: a short recorded deterministic prefix to establish the relevant list/filter/client state before the candidate, with credentials excluded. This does not require a general graph planner. If a prerequisite cannot be restored safely, label that scenario unsupported/inconclusive and keep it out of claims of successful replay.

Acceptance: an authenticated client-state-dependent scenario replays correctly in a fresh context; an unrestorable prerequisite never becomes a falsely rejected defect.

## 5. Close the ordinary-user workflow and fixture parity

Confirmed issues to reproduce and fix:

- The UI lists profiles, but has no create/edit project workflow.
- Issue cards show an evidence level but do not link to screenshot/network/console evidence.
- Initial page load does not restore activeRun from the API. Refresh can lose progress/Stop access even though the run is still active.
- Polling active status returns run identity, not the latest counters.
- The live notice shows limits but profile-list responses omit provider/model identity.
- Fixture preflight says NOT READY until a server runs, although starting a fixture run starts that server itself; QUICKSTART simultaneously says fix every failure before continuing.
- RunManager.startRun does not enforce preflight. A failed real-target scope/readiness check is only advisory.
- profileToAppConfig initializes uiApiConsistency.rules and duplicateRequest.patterns as empty arrays. Sharing runPipeline/assembleReport does not ensure parity when the UI fixture and CLI mock configuration enable different checks.

Add a small profile form and safe save endpoint, evidence links/previews, active-run recovery and latest-event status, clear real-provider identity, and consistent readiness semantics. For the managed fixture, report it as launchable/managed when appropriate instead of a blocking unreachable external target. Check actual configuration/scope before probing unapproved URLs; keep redirects within approved preflight scope. Apply preflight against the effective selected mode, so Demo does not require live credentials.

Restore fixture profile parity by reusing the same approved oracle/requirement configuration as the CLI positive control. Keep fixture-specific data out of real profiles. Compare equivalent UI and CLI fixture runs by defect identities and dispositions, not merely findingCount > 0 or canonicalCount < rawCount.

Exercise the rendered UI in a real browser: create/edit safe profile, run fixture, open evidence, refresh mid-run, Stop, reopen history, and receive actionable failures. HTTP API tests alone cannot prove these interactions.

Do not add cloud hosting, frameworks, databases, multi-user accounts, or unrelated UI features. Retain loopback/security defenses and test file containment against the trusted runs root as well as each run directory.

## 6. Complete the pilot, or state exactly what remains pending

After the safety/auth/UI corrections, recheck OrangeHRM availability. An owned reachable sandbox or a verified native setup is valid; missing Docker only rules out that installation path. Do not install privileged software or modify unrelated services without the needed authorization. Never use a public hosted demo as a fallback.

Prepare a concrete pinned setup and three-to-five-page, five-to-ten-safe-workflow pilot. Verify actual login locators/routes/API requirements against the chosen version. Do not widen allowlists just to get a green run. If the environment is unavailable, complete all independent work and provide the specific next setup step. Keep live-pilot acceptance pending.

src/reporting/pilot-report.ts currently maps heuristic counts to declared/executed workflows, and its builder is not wired into the ordinary execution path. Integrate an actual pilot artifact with a declared workflow manifest and distinct heuristic/action counts. Do not call generated heuristic combinations business-workflow coverage.

No real target ground truth means recall/F1 and dataset precision are unavailable. Actual human triage must remain separate from machine disposition. Do not invent human participation, bug counts, live-provider success, or pricing. Zero genuine findings is a valid pilot outcome. Use an explicitly labeled controlled scenario if needed to demonstrate replay; never call it an upstream OrangeHRM bug.

## 7. Verification and honest handoff

Run targeted regressions for the confirmed gaps, then typecheck, default tests, build followed by default tests, and appropriate fixture/browser acceptance. Explicitly pass qa.config.mock.yaml to existing capture/QA/benchmark commands during development. Confirm Phase 3 fixture behavior and mock capture/replay integrity remain intact. Live command gating must be tested without real API calls.

Update PROGRESS.md, README.md, QUICKSTART.md, and docs/PHASE4_ACCEPTANCE.md. Remove duplicate milestone entries and correct overstated completion claims. In particular, request accounting, recorder ordering, scope enforcement, Stop semantics, and UI acceptance must match the code and observed tests.

Record actual test results, run IDs, artifacts, UI screenshots, and any pending target/model/human dependencies. Phase 4 remains partial until required real-application acceptance occurs; passing unit tests alone does not close it.

Final response: what was fixed; files changed; actual verification; usable startup command; UI/CLI parity; target/pilot status; request and cancellation guarantees; remaining limitations; and explicit confirmation that no staging, commit, push, PR, or GitHub write was performed. Leave all work for my manual review and commit.

Begin by confirming the current tree and the findings above. Then fix in dependency order without restarting planning or rebuilding already-working components.
