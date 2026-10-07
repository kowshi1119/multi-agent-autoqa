# Phase 13 / 13.1 acceptance checklist: trustworthy API observation and the UI–API pilot

Updated 2026-10-06. Cells contain real evidence (test file, run ID, verification ID) or `pending: <exact dependency>`. A commit or a push is not verification. Historical test counts are not fresh verification.
Synthetic run IDs are in this machine's git-ignored `runs/` folder (demo: `npm run build && node dist/tests/demo/phase13-demo.js`). Verification records are in the git-ignored `verification/<ID>/` folder.

## Status at a glance (three independent statuses)

| Status | State |
|---|---|
| Engineering verification | See section C: a full `npm run verify:local` on the frozen source, with its verification ID |
| Synthetic end-to-end acceptance | **Verified** on synthetic fixtures (sections A, B; Phase 13.1 demo below) |
| Real Ajeer acceptance | **Pending:** no Ajeer run has used Phase 13; needs your local sign-in and approvals (section D) |

## A. Observer reliability

| Criterion | Before Phase 13 | Engineering | Synthetic evidence |
|---|---|---|---|
| Body read only when its decoded size is known to be ≤ 256 KiB **before** `body()` | Buffered first, trusted Content-Length (**defect**) | Identity coding + finished + received-bytes bound + (13.1) declared length must equal received bytes; compressed → metadata only | `api-observer-bounds.test.ts`: `body()` is never called for compressed, oversized or non-2xx responses |
| Cache and revalidation (13.1) | — | A cache hit reports a negative body size (-135 observed) and a 304 revalidation reports 0 bytes received (with a 5 027-byte cached body), both in Playwright 1.62.1 → metadata only | "never reads a cached or revalidated body": `body()` called once each, for the network response only |
| Bounded work | Depth/paths only | Responses, concurrency, queue, traversal nodes, properties, array samples, depth, paths, endpoints, strings, artifact size, drain | Bounds tests (wide 2 000 keys → 51 nodes; node limit; queue-full ×2; artifact ≤ 6 000 B) |
| Privacy of names, segments, page paths, query names, media types | Alphabetic names kept (**defect**) | Vocabulary or profile allow-list; positional masking | Canary sweeps (observation; run directory for password, email and cookie) |
| Origin-aware identity; ambiguous templates never executable | Method + path only (**defect**) | Origin key; `ambiguous`; `mergedDistinctPaths` | Two origins → two observations; masked path → no executable draft |
| Sign-in exclusion | — | Starts only after sign-in succeeds | `/session` never observed; (13.1) failed sign-in → no observation file, no API call |
| Lifecycle: detach, drain, freeze, page attribution | No stop | `attach/start/stop` | Stop/drain/freeze test; (13.1) listener counts back to their previous values after `stop()`; attribution test |
| Zero additional requests | Loose | — | Observer on vs off: identical request logs |

## B. Generic product flow

| Criterion | Synthetic evidence |
|---|---|
| Observation → reviewable drafts; facts, proposals, approval and official contract kept apart; server re-derivation; stale/tampered/cross-application refused | `observed-drafts.test.ts` |
| **Stage B (13.1):** an executed, approved structure-only check → proposals from its digest-protected evidence, with no request; stale definition, tampered evidence, another application and traversal refused; approval makes suites selecting the check stale until re-saved | `evidence-drafts.test.ts`; demo steps 3–4 |
| Structure-only evidence; confirmation keeps its query (**defect fixed**, regression test) | `structure-only-evidence.test.ts` |
| UI–API comparison: pass; reproduced mismatch; data changed; not reproduced (13.1: now reachable and tested); ambiguous identity; page-scope mismatch; missing field with an independent required-field check failing; money refused; budget; auth; Stop then a usable next run | `consistency.test.ts` (16 tests) |
| UI flow: observed → drafted → approved → comparison → suite → baseline | `tests/server/api-observation-ui.test.ts` |

Phase 13.1 demo (2026-10-06, real local server API, synthetic fixture with **gzip-compressed** `GET /api/statement-list`, fixture state set explicitly per scenario):

- Observation of the compressed endpoint: 0 body samples, omission `body-size-unknown-compressed`.
- Stage A: stale digest refused (HTTP 409). Status and content-type check approved.
- Stage B: proposals `items:array, page:number, pageSize:number, total:number`, with **0 requests** to the application while drafting. `items` and `total` approved.
- Suite "api" became invalid ("changed since suite revision 1") and was re-saved explicitly as revision 2.
- Money comparison refused (HTTP 422).
- Baseline approved explicitly for scenario 6.
- Canary sweep over all 8 runs: no synthetic password; no compared record values in check, comparison, suite, coverage, summary or log files.

| Scenario | Fixture state | Run | Suite | UI–API comparison | vs baseline | HTTP check requests |
|---|---|---|---|---|---|---|
| 1. Observation run (workflow only) | {} | `RUN-20261006-104411522Z-3b51` | PASS | — | — | 0 |
| 3. Approved check executed | {} | `RUN-20261006-104414509Z-d3df` | PASS | — | — | 1 |
| 6. Matching UI and API | {} | `RUN-20261006-104416718Z-b5cc` | PASS | passed | — | 3 |
| 7. Seeded API status mismatch | apiStatusMismatch | `RUN-20261006-104418942Z-fb04` | FAIL | failed (reproduced) | newly-failing | 5 |
| 8. Corrected application | {} | `RUN-20261006-104421393Z-d2f2` | PASS | passed | unchanged-passing | 3 |
| 9. Data changes between observations | apiStatusFlapping (even calls) | `RUN-20261006-104423662Z-7d34` | INCOMPLETE | not assessed (data-changed) | not-executed | 5 |
| 10. Stop during the comparison | apiStatusMismatch | `RUN-20261006-104425842Z-29e5` | INCOMPLETE | not assessed (cancelled), first mismatch kept | not-executed | 5 |
| 11. Next run after Stop | {} (reset) | `RUN-20261006-104428177Z-ac87` | PASS | passed | unchanged-passing | 3 |

## C. Engineering verification

| Criterion | Evidence |
|---|---|
| Full `npm run verify:local` (typecheck, build, full test suite, corpus validation) on one unchanged source | See `docs/release/PHASE13_1_EVIDENCE.md` (verification ID, per-stage results, test counts) |
| Canonical benchmark as a **separate** run (corpus validation is not the benchmark) | See `docs/release/PHASE13_1_EVIDENCE.md` |
| Existing check definition hashes unchanged (new fields optional) | Existing suite tests pass |

## D. Ajeer acceptance (real application)

| Criterion | Real-app evidence | Your action |
|---|---|---|
| Navigation suite still passes | Last evidence `RUN-20260929-111030051Z-576d` (PASS 3/3, before Phase 13); fresh run **pending** | Sign in locally and run the suite (run A) |
| Requirements approved | All three approved by you (RECIPIENTS and BILLPAY-PAGE 2026-09-29, HISTORY-PAGE 2026-10-01) | — |
| Observation of Ajeer's own API | **pending:** run A | Run A |
| Approved read-only API checks | **pending:** exact proposals from run A, then your decision | Approve or decline them |
| UI–API comparison | **pending:** only if Transaction History shows a table whose key column maps to an observed field with the same page scope; otherwise unsupported | — |
| Separate repeat; Stop then a usable next run | **pending** | Runs B and C; one Stop |
| Baseline | Not approved; it is your decision | Your click |
| Account workflow | Excluded: `/account` prefetches `GET /account/delete`, which stays blocked | — |

## Known limitations

- **Application map (closed by Phase 14 for new real-target runs).** Real targets now default to the minimal evidence policy (`docs/privacy/EVIDENCE_POLICY.md`). Older runs, including the Ajeer runs from 2026-09-29, keep their original local files; exports label them *legacy / privacy-unclassified* and include no observed text.
- **Stage B scope.** Stage B proposes only named top-level field types from one executed response.

## Phase 14 note on Ajeer

- **2026-10-07 attempt:** `RUN-20261007-040204103Z-22b2` ended with `AUTH_FAILED (stayed-on-login)`. The password was not accepted, and AutoQA did not retry. No workflow ran and nothing was observed. Confirm the current Ajeer password before the next local run.
- **Next run:** it will use the minimal evidence policy.
