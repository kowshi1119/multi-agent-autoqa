# Phase 13.1 release evidence (2026-10-06)

Status: **Engineering verified** · **Synthetic acceptance verified** · **Ajeer acceptance pending**

## Verified source
- Base commit `b9360fd`, plus the Phase 13.1 working-tree changes listed by name in the verification summary (24 paths).
- The release commit contains exactly those changes, plus the documentation-only files listed under "After verification".
- The verification recorded the same working-tree state at start and end (`sourceChangedDuringRun` absent).

## Verification `VER-20261006-105641629Z-79b5` (`npm run verify:local`)
Toolchain: Node v24.19.0, npm 11.17.0, TypeScript 5.9.3, vitest 4.1.11, Playwright 1.62.1, Chromium 151.0.7922.34 (revision 1234). Environment-variable values are not recorded.

| Stage | Command | State | Duration |
|---|---|---|---|
| typecheck | `npm run typecheck` | passed | 8 s |
| build | `npm run build` | passed | 9 s |
| test | `npm test -- --maxWorkers=2` | passed: 112 files, 836 tests, 0 failed, 0 skipped | 519 s |
| challenge-corpus | `npm run challenge-corpus:validate` | passed (20 cases valid) | 9 s |

Local records, git-ignored: `verification/<ID>/summary.json` and one log per stage. Earlier records are kept:
- **`VER-20261006-104601509Z-0966`:** also passed (834 tests). Superseded because the runner's own metadata was wrong (browser version missing; `.gitignore` recorded as `gitignore`). Both were fixed with regression tests.

## The historical failure
- **Phase 13 run (2026-10-01):** a full run exited with code 4. The log is lost, so the stage is **unknown**, and it was not reproduced.
- **Re-run on 2026-10-06 against unchanged `b9360fd`:** typecheck, build and tests passed (110 files, 819 tests). The corpus stage failed (exit 2) because a new source file was written *during* the run and that stage's `tsc` compiled it. Corpus validation alone on the clean tree: VALID.
- The new runner records the source state at start and end, and refuses to call a run verified if the source changed.

## Canonical benchmark (separate from corpus validation)
`npm run qa -- --config qa.config.mock.yaml` → `RUN-20261006-110606660Z-213a`. 74 actions, 38 mock decisions. Definitions, labels and matching rules are unchanged.

| Metric | Precision | Recall | F1 |
|---|---|---|---|
| Raw detection (6 TP, 3 FP, 0 FN) | 0.667 | 1.000 | 0.800 |
| Final report | 0.75 | 1.00 | 0.86 |
| Grouped | 1.0 | 1.0 | 1.0 |

This is the same as the previous recorded figures.

## Synthetic acceptance
Phase 13.1 demo, 2026-10-06 (`node dist/tests/demo/phase13-demo.js`). The run IDs and the scenario table are in `docs/AJEER_PILOT_ACCEPTANCE.md`, section B.
- Compressed API: metadata-only observation.
- Stage A: an approved status and content-type check.
- Bounded execution: 1 request.
- Stage B: proposals with 0 requests; approval of `items` and `total`.
- The suite became stale and was re-saved explicitly.
- Comparison: match; reproduced mismatch; correction; data changed; Stop; then a healthy next run.
- Canary sweep: clean.

## Ajeer
No Ajeer run used Phase 13 or 13.1. The last Ajeer evidence is `RUN-20260929-111030051Z-576d` (navigation suite PASS 3/3). All three Ajeer requirements are approved by the user. No Ajeer API check or comparison exists, and no baseline is approved.

**Pending, in this order:**
1. Your fresh local sign-in run (A).
2. Your decision on the exact proposals from it.
3. Runs B and C.
4. One Stop.

## Known limitations
- The Phase 1 application map (`report.json`, `application-map.json`) records the visible names of controls and links on visited pages. These are local, git-ignored files. Tracked as a separate task.
- Untested browser cache paths (prefetch, back/forward cache, partial content) rely on the declared-length and post-acquisition checks.
- Stage B proposes only named top-level field types from one executed response.

## After verification (documentation only)
`PROGRESS.md` (Phase 13.1 entry), `docs/release/PHASE13_1_EVIDENCE.md` (this file).
