# AutoQA — Progress

Phase 1 is COMPLETE. Phase 2 is COMPLETE. Phase 3 is IN PROGRESS. This
file is kept for historical/resumability reference; see README.md for the
actual system documentation.

**Continuity rule (Phase 3):** if this session is interrupted or runs low
on context, the checklist below must reflect the exact sub-milestone
reached — never mark a box done unless its listed tests are green and
`npm run typecheck` passes. A sub-milestone landed only partially must be
described as partial, with the specific unmet acceptance bullet named.

## Phase 3 — Reliability and Research Evidence (plan: see the three
confirmed bugs and full milestone breakdown this session's plan-mode
output produced; summarized progress below)

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
- [ ] A2 — Evidence aligned with successful reproduction (validator
      capture policy + failure-signature matching + evidence-scope
      disclosure + README Trace-Capture Policy rewrite)
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
- [ ] C3 — Challenge corpus (≥12 distinct-defect + ≥8 non-defect cases)
- [ ] C4 — Blind human review export/import
- [ ] D — Verification and handoff (README/PROGRESS updates, full
      command-output capture, security re-scan)

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
