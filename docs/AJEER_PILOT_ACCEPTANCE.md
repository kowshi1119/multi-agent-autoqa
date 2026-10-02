# Phase 13 acceptance checklist: trustworthy API observation and the UI–API pilot

Updated 2026-10-01. Cells contain real evidence (test file, run ID) or `pending: <exact dependency>`. Historical test counts are not fresh verification; fresh results are in PROGRESS.md.
Synthetic run IDs are in this machine's git-ignored `runs/` folder (demo: `node dist/tests/demo/phase13-demo.js`).

## Status at a glance

| Gate | State |
|---|---|
| A. Observer reliability | Met on synthetic fixtures (see section A) |
| B. Generic product flow | Met on synthetic fixtures (see section B) |
| C. Integration | Met; full suite result in PROGRESS.md |
| D. Ajeer acceptance | **Pending:** needs fresh local sign-ins and your approvals (see section D) |

## A. Observer reliability

| Criterion | Before this phase | Engineering this phase | Synthetic acceptance |
|---|---|---|---|
| Body acquired only when the decoded size is known ≤ 256 KiB before `body()` | Implemented, but buffered first and trusted Content-Length (**defect**) | Fixed: identity coding + finished + received-bytes bound; compressed → metadata only | `api-observer-bounds.test.ts` ("never acquires…": `body()` never called for compressed/oversized/non-2xx) |
| Bounded responses, concurrency, queue, traversal nodes, properties, array samples, depth, paths, endpoints, string lengths, artifact size, drain | Partly (depth/paths only; wide objects unbounded) | Added (`OBSERVER_LIMITS`), with structured omissions | Bounds test (wide 2 000 keys → 51 nodes; node limit; queue-full ×2; artifact ≤ 6 000 B with `artifactTruncated`) |
| Privacy of names, segments, page paths, query names, media types | Alphabetic keys/segments kept (**defect**) | Allow-list vocabulary + profile `apiObservation`; positional masking; `{seg}`/`{id}` | Canary sweep (values, keys, segments, query values, page path, service-worker body); run-dir sweep for password/email/cookie (`api-observer.test.ts`) |
| Endpoint identity: origin + method + safe template; collisions | Keyed by method + path (**defect**) | Origin-aware key; `ambiguous`; `mergedDistinctPaths` | Two origins, same path → two observations; jane/john paths merge → ambiguous |
| Completeness: samples, empty arrays, omissions | No sampling record | `seenIn k/n`, `emptyArrays`, omissions | Bounds test (empty, long, deep, wide) |
| Lifecycle: after sign-in, detach, drain, freeze, page attribution | Attached before sign-in; no stop | `attach/start/stop`; frozen result; request-time page; navigation flag | Stop/drain test; attribution test (pushState during request) |
| Zero additional requests | Asserted loosely | — | Observer on vs off: identical request logs on two origins |

## B. Generic product flow

| Criterion | Synthetic acceptance |
|---|---|
| Observation → reviewable drafts; facts, proposals, approval and official contract kept separate | `observed-drafts.test.ts` (pure); route test |
| Approval re-derived on the server; stale, tampered, cross-application, target-changed and non-fact drafts refused; no request while drafting | Route test (409/422; request log unchanged). Demo: stale digest → HTTP 409 |
| Structure-only evidence (no body in check or finding evidence) | `structure-only-evidence.test.ts`; observed-drafts route test |
| Failing check's confirmation keeps its query (**defect fixed**) | `structure-only-evidence.test.ts` (fails before the fix, passes after) |
| UI–API comparison: match / reproduced mismatch / corrected / data changed / missing field / ambiguity / scope / money refused / budget / auth / Stop then a usable next run | `consistency.test.ts` (13 tests); demo runs below |
| UI flow: observed → drafted → approved → comparison → suite → baseline | `tests/server/api-observation-ui.test.ts` |

Demo runs (2026-10-01; synthetic fixture and synthetic credentials, through the real local server API):

| Scenario | Run | Suite | UI–API comparison | vs baseline |
|---|---|---|---|---|
| Observation run | `RUN-20261001-130355916Z-0b39` | PASS | — | — |
| Matching (approved as baseline, explicitly) | `RUN-20261001-130359990Z-6597` | PASS | passed | — |
| API status differs, reproduced | `RUN-20261001-130402616Z-5c0f` | FAIL | failed | newly-failing |
| Corrected | `RUN-20261001-130405758Z-5979` | PASS | passed | unchanged-passing |
| Data changes between observations | `RUN-20261001-130408416Z-5187` | INCOMPLETE | not assessed (data-changed) | not-executed |
| Missing API field | `RUN-20261001-130410916Z-c714` | INCOMPLETE | not assessed (missing-field) | not-executed |
| Stop during the comparison | `RUN-20261001-130413350Z-43ac` | INCOMPLETE | not assessed (cancelled), first mismatch kept | not-executed |
| Next run after Stop | `RUN-20261001-130415794Z-db71` | FAIL | failed | newly-failing |

## C. Integration

| Criterion | Evidence |
|---|---|
| Requirements, suites, baselines, comparison, coverage report, CLI keep their semantics; new kind `consistency-check` | Full suite on frozen source (PROGRESS.md); suite/requirement/coverage tests unchanged and passing |
| Existing check definition hashes unchanged (new fields optional) | Existing suites still validate (suite tests) |
| Canonical benchmark labels and scoring unchanged | `npm run verify:local` (PROGRESS.md) |

## D. Ajeer acceptance (real application)

| Criterion | Real-app acceptance | Your action |
|---|---|---|
| Three navigation workflows still pass | Last evidence `RUN-20260929-111030051Z-576d` (PASS 3/3); fresh run pending | Sign in locally and run the suite (run A) |
| Requirements approved | RECIPIENTS and BILLPAY-PAGE approved by you (2026-09-29); HISTORY-PAGE still draft | Decide on REQ-AJEER-HISTORY-PAGE in 1f |
| Hardened observation of Ajeer's own API | pending: run A | Run A |
| Approved read-only API checks | pending: proposals from run A, then your approval | Approve or decline the exact proposals |
| One valid UI–API comparison | pending: only if Transaction History shows a table whose key column maps to an observed field with the same page scope; otherwise unsupported | — |
| Separate repeat run | pending | Run C |
| Stop, then a usable next run | pending | Press Stop once during a run, then run again |
| Baseline | Not approved. The previous run is eligible; approval is your click | Your decision |
| Account workflow | Excluded: `/account` prefetches `GET /account/delete`, which stays blocked | — |
