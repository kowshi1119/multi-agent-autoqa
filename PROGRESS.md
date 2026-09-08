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
- [ ] A2 — Evidence aligned with successful reproduction (validator
      capture policy + failure-signature matching + evidence-scope
      disclosure + README Trace-Capture Policy rewrite)
- [ ] A3 — Shared review path (`phase2-experiment.ts` import-side-effect
      fix + `ReviewService` extraction + structured claim checks)
- [ ] B — Conservative cross-finding grouping
- [ ] C1 — Phase 3 experiment harness (descriptive-ID conditions, manifest
      capture/replay)
- [ ] C2 — Benchmark versioning + duplicate-aware matcher
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
