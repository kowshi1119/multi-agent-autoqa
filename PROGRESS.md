# AutoQA Phase 1 — Progress

## Baseline (M1) — verified 2026-09-04
- Windows, Node v24.19.0
- `npm run typecheck`: PASS
- `npm test`: PASS (20/20, Phase-0 suite)
- `npm run qa`: PASS (verified earlier this session — mock provider, seeded console-error defect validated 3/3, all evidence artifacts written)
- `git status`: clean tree at start of Phase 1
- `runs/RUN-*` directories confirmed NOT tracked by git (only `runs/.gitkeep` is)

## Milestones (10)
- [x] M1 — Phase-0 verification + architecture assessment
- [x] M2 — Explicit orchestrator FSM (states.ts, run-context.ts; orchestrator.ts driver deferred into M6)
- [x] M3 — Enhanced Observation + page/module mapping
- [x] M4 — QA heuristic framework + initial heuristic library
- [x] M5 — Multiple deterministic oracle types
- [x] M7 — Safety/navigation improvements + budgets (built before M6, since the
      Orchestrator being built in M6 depends on BudgetTracker + navigation guards)
- [ ] M6 — Multi-page autonomous exploration (Planner, Explorer/Provider rewrite,
      Orchestrator driver, index.ts rewrite, dedup, Finding extension) — IN PROGRESS
- [ ] M8 — Enhanced fixture + seeded-defect benchmark
- [ ] M9 — Run-level reporting + coverage metrics
- [ ] M10 — Full Phase-1 acceptance run + README + final verification

Two real bugs found and fixed via the M7 real-browser safety test (not just
unit mocks) -- see commit aff158b. Worth remembering: context.on('page')
fires for our own context.newPage() too, and a popup's first navigation
request can throw from request.frame().

## Key architectural decisions (from design pass, adopted)
1. **Observation shape**: breaking change to `page.{url,title,pathname}` (spec explicitly requires it). All consumers updated in the same milestone (M3) to avoid a half-migrated state.
2. **ExplorerInput**: candidate-ID protocol (`{observation, candidates, recentActions, remainingActions, remainingModelCalls, remainingDurationMs}`); model picks a `candidateId`, never raw actions, for heuristics/navigation/stop alike.
3. **Finding**: keeps `steps: RecordedStep[]` (needed for Validator replay) and adds `pathname` (needed for dedup/benchmark keys) beyond the spec's illustrative type — both are necessary deviations, documented.
4. **Finding.steps scoped to the triggering candidate's actions only**, not full run history — this is what makes "continue after a finding" work with the unmodified Validator (which replays `finding.steps` verbatim from `finding.url`).
5. Page-mapping identity (`PageNode`, keyed by normalized pathname) vs. state-signature (pathname+controls+visibleText) are kept as two distinct concepts — conflating them either explodes the map or under-counts heuristic tracking.
6. Validator replay does NOT consume `maxActions`/`maxModelCalls`/`maxPages` (reproduction, not exploration) — only `maxDurationMs` is enforced inside Validator.
7. `maxFindings` reached stops the whole run immediately (simplest reading of "stop only on maxFindings").
8. Off-origin navigation: 4-layer defense-in-depth (route() abort, post-action URL check+revert, framenavigated async catch, popup/new-tab close). ALL popups closed (even same-origin) — Phase 1 has no multi-tab exploration.
9. Native dialogs (alert/confirm/beforeunload) always auto-dismissed; no dialog-targeting heuristic in Phase 1.
10. Trace-capture policy UNCHANGED from Phase 0: validator attempt 1 only. Documented explicitly per spec §0.6.
11. SEED-005 (whitespace-required-field) placed on `/account`, not `/form`, to stay distinguishable from SEED-001 under both the dedup key and benchmark matcher (both keyed partly on oracleId+pathname; two console-error defects on the same page would collide).

## Full design reference
See design-agent output captured in this session's transcript (2 messages, ~340k tokens combined) for exact function signatures per module. Not duplicated here in full — this file tracks progress/state for resumability, not the full design.

## Environment
- No ANTHROPIC_API_KEY / OPENAI_API_KEY / reachable Ollama in this environment (reconfirmed). Live-provider smoke test will be skipped and reported plainly, not fabricated.
