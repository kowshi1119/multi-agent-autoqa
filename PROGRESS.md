# AutoQA Phase 1 — Progress

Phase 1 is COMPLETE. All 10 milestones landed and verified. This file is
kept for historical/resumability reference; see README.md for the actual
system documentation.

## Milestones (10) — all complete
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

## Final acceptance result (representative run)
- 5/5 fixture pages visited, 100% heuristic coverage (25/25 offered combos)
- 5 findings, all validated (3/3 or better reproduction)
- Benchmark: precision 0.80 / recall 0.80 / F1 0.80 (4 TP, 1 documented FP,
  1 documented FN — see README Known Limitations)
- 105/105 tests pass, strict typecheck clean, `npm run qa` and
  `npm run benchmark` both verified end-to-end from a clean state

## Real bugs found and fixed by actually running this (not just unit tests)
1. Navigation priority ordering: navigation candidates outranking heuristic
   candidates meant the agent toured every page with zero interactions and
   never found anything. Fixed by sorting all heuristic tiers before
   navigation.
2. `installPopupGuard` installed before AutoQA's own `context.newPage()`
   closed AutoQA's own exploring page (Playwright's `page` event doesn't
   distinguish "we created this" from "content opened a popup").
3. A popup's first navigation request can throw from `request.frame()`
   (frame not yet constructed) inside the route guard.
4. `InteractiveElement.role` classifier labeled every non-checkbox/radio/
   button input "textbox" — including number inputs (real ARIA role:
   spinbutton) and search inputs (real role: searchbox) — so every locator
   for a number field silently failed via Playwright's `getByRole()`.
5. Console/network/dialog events arrive asynchronously over CDP; snapshots
   taken without a settle wait let an event from one action leak into the
   next cycle's diff, misattributing anomalies to the wrong page/action.
6. H10 (double submission) never filled required fields first, so native
   HTML5 form validation could silently block both submit attempts,
   meaning the double-submit scenario was never actually exercised.
7. Oracle registry order mattered: EVALUATE stops at the first suspicious
   oracle per action, and a double-click can trigger two oracles at once;
   reordered so the more specific, pattern-scoped oracle wins.
8. `RunContext.heuristicsApplicableCount` was an incrementing counter
   bumped on every *offer* across every cycle (an unexecuted candidate is
   re-offered every cycle until chosen), over-counting by roughly a
   triangular-number factor. Replaced with a Set of distinct offered keys.

## Environment
No ANTHROPIC_API_KEY / OPENAI_API_KEY / reachable Ollama in this
environment (reconfirmed throughout Phase 1). All verification used
MockModelProvider; AnthropicModelProvider is implemented against the same
interface but has not been exercised live.
