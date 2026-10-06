# Research decision record — passive API observation and UI–API comparison (Phase 13)

Date: 2026-10-01. Installed versions: **Playwright 1.62.1** (Chromium), Node's built-in `fetch` (undici) for AutoQA's own check requests.
Scope: only the decisions this phase needed. Each entry lists the source, whether it applies to the installed version, the chosen behaviour, its limits, and the test that verifies it.

## D1. When Playwright buffers a response body

- **Sources:**
  - https://playwright.dev/docs/api/class-response: `body()` "Returns the buffer with response body"; `finished()` waits for the response to finish.
  - Installed source `node_modules/playwright-core/lib/coreBundle.js`: the Chromium `getResponseBody` path sends CDP `Network.getResponseBody`.
- **Applicability:** verified in the installed 1.62.1 code, not only the docs.
- **Finding:**
  - `body()` returns the **whole decoded body at once**. The browser has already buffered it for DevTools, and there is no partial or streaming read.
  - A size check after `body()` therefore cannot be a memory limit.
- **Decision:** the observer calls `body()` only after it knows, **before acquisition**, that the decoded size is within 256 KiB (D2). Otherwise the response is recorded as metadata only, with a structured omission reason.
- **Limitation:** the browser's own buffering is owned by Chromium, not by the observer, and is not bounded by AutoQA.
- **Verified by:** `tests/checks/api-observer-bounds.test.ts`, "never acquires a body whose decoded size is not known within the bound": it wraps `Response.prototype.body` and asserts it is never called for the compressed, oversized or non-2xx responses.

## D2. Whether decoded bytes can be bounded before acquisition

- **Sources:**
  - RFC 9110 §8.6: Content-Length is the length of the representation **after** content coding.
  - Installed source: `request.sizes().responseBodySize` = `loadingFinished.encodedDataLength − responseHeadersSize`. This is the **encoded** size, falling back to `Content-Length` only when unknown.
- **Findings:**
  - With identity coding, the decoded body equals the bytes received. With gzip/br/deflate/zstd, the decoded size is unknown and unbounded by the encoded size: a 2 MB body compresses to a few KB.
  - In testing, the body-only figure **undercounted a chunked body** (it subtracts a header estimate), so `body > sizes.responseBodySize` falsely tripped.
- **Decision:**
  - Acquire only when there is no `Content-Encoding` (or `identity`), the response finished, and the total received (`responseBodySize + responseHeadersSize`) is at most 256 KiB.
  - After acquisition, discard the body if its length exceeds that total or the cap (`body-size-mismatch`).
  - Compressed responses are metadata only (`body-size-unknown-compressed`).
- **Rejected:** a CDP side session summing decoded `Network.dataReceived` bytes. Playwright does not expose the CDP request id, and correlating by URL is ambiguous for concurrent identical requests.
- **Consequence for Ajeer:** if its API responses are compressed (common), no shapes are observed. Drafts then offer only status and media type. Structure can be learned from an **approved** check's own response: AutoQA's `fetch` streams through Node's decompressor, so its decoded-byte cap is enforced chunk by chunk (`src/checks/http-client.ts`).
- **Verified by:** the bounds test, with compressed (honest encoded Content-Length, 2 MB decoded), chunked/no-Content-Length (still bounded), 1 MB, malformed and interrupted cases.

## D3. Cancellation and pending work

- **Sources:**
  - Playwright docs: `finished()`.
  - Observed in 1.62.1: `finished()` did **not** settle for a request that failed in transit (the drain timed out).
- **Decision:**
  - Every wait is raced against a per-response timeout (5 s) and a `requestfailed` signal.
  - Concurrency is 4, the queue 16; overflow is counted as `queue-full`.
  - `stop()` detaches every listener, refuses new work and drops queued work as `interrupted`. It waits up to 2 s for in-flight work, then freezes the result and records `drained` or `drain-timeout`. Late completions cannot change it.
  - The pipeline stops the observer **before** any check or comparison runs, and `closeSession` stops it too.
- **Verified by:** "bounds concurrency and queue length, and stop() drains within its timeout and freezes the result", plus the delayed/interrupted cases.

## D4. Service workers and caches

- **Sources:**
  - https://playwright.dev/docs/network: Service Workers can take over requests (e.g. MSW), making them invisible to routing; `serviceWorkers: 'block'` disables them.
  - Class Response: `fromServiceWorker()`.
- **Decision:** run sessions do **not** block service workers, because blocking would alter the application's behaviour to collect evidence.
  - A response fulfilled by a service worker is recorded as metadata only (`from-service-worker`).
  - Requests a service worker makes itself are not page events and are not observed.
  - HTTP cache hits are not distinguishable from network responses.
  - All of this is documented in every observation's `limitations`.
- **Verified by:** "records responses served by a service worker as metadata only" (a real registered worker; its canary value never appears).

## D5. Which metadata can carry personal data

- **Source:** OWASP Logging Cheat Sheet. Session identifiers and access tokens should not be logged directly. Sensitive personal data needs special handling; file paths and URLs (including query strings) may carry sensitive data. Recommended techniques are deletion, scrambling or pseudonymisation.
- **Decision:** property names, query names, path segments, page paths, content-type values and error text are all treated as potentially personal.
  - A **name** is kept only if every word is in a small generic API vocabulary (`src/auth/api-observer.ts`) or configured in `profile.apiObservation.knownFields`. Otherwise it becomes `<field#n>` / `<param#n>`, where *n* is the position, not a hash: a hash of a low-entropy name is dictionary-reversible.
  - **Path segments:** id-like segments become `{id}`; unknown segments become `{seg}`, which marks the endpoint `ambiguous`; approved `routeTemplates` are used verbatim.
  - **Media types:** only listed media types are kept; anything else becomes `other`.
  - **Not persisted:** values, query values, cookies, headers and bodies. Errors are reason codes only.
- **Limitation:** this is heuristic. It reduces, but cannot guarantee the absence of, personal data in names the application chose. For example, a key that is a generic word but carries a meaning is kept.
- **Verified by:** a canary sweep over the observation artifact (values, keys, path segments, query values, page path, service-worker body), plus an all-files sweep of a real run directory for the password, email and session-cookie values (`tests/checks/api-observer.test.ts`).

## D6. Observation versus contract

- **Source:** OAS 3.0.4 Schema Object. Properties not in `required` are optional, and paths that differ only by template names are identical.
- **Decision:**
  - Every observation is labelled "Not an official API contract".
  - Shapes record `seenIn: k/n samples`. Arrays seen only empty are listed and say nothing about their elements. Omissions record sampling (`array-sampled`, `properties-limit`, `depth-limit`, `nodes-limit`, `paths-limit`).
  - Drafts propose `required` only as an explicit opt-in, and never propose enums, values or invariants.
  - A draft keeps `observedFacts`, `proposedAssertions`, the user's selection and `officialContract: null` apart.
- **Verified by:** `tests/checks/observed-drafts.test.ts`.

## D7. Safety of replaying a GET

- **Source:** RFC 9110 §9.2.1. "Safe" describes the method's defined semantics; it does not prevent an implementation from having side effects.
- **Decision:**
  - An observed GET never authorizes a request.
  - A check exists only after explicit approval, which the server re-derives from the stored observation and re-checks against:
    - the target fingerprint;
    - the observation digest (stale or tampered);
    - the profile (cross-application);
    - scope;
    - masked or parameterised paths and query names;
    - credential-looking parameters.
  - Enabling API checks is a separate explicit flag.
- **Verified by:** the observed-drafts route test (stale, target-changed and cross-application all give 409; non-fact assertions give 422; no request reaches the application while drafting or on refusal).

## D8. What makes two UI/API observations comparable

- **Sources:** derived from D6 and D7 plus basic measurement practice: the same entity, the same collection scope, the same field meaning, and a stated time relationship. No external standard defines this for arbitrary apps, so it is recorded as an AutoQA rule, not a standard.
- **Decision:** the comparison must name the record identity (key column ↔ key field), the field mapping, a fixed relation (normalized text, status, or row count of the same page) and the scope (page and page-size parameters fixed to the UI's first page).
  - Money and date/time mappings are refused, because they need exact numeric or time semantics.
  - Two modes are stated in every result:
    - `rendering-response`: the response the page itself fetched while rendering that load. It is passive and uses the D1/D2 bounds.
    - `separate-check`: UI first, then the approved check. This is **not** an atomic snapshot.
  - A mismatch fails only if one re-observation of **both** sides reproduces it with unchanged data. A value change between attempts is `data-changed`; a vanished mismatch is `not-reproduced`.
  - Duplicate or absent keys are `ambiguous-identity`, a missing field is `missing-field`, and a wider UI page is `scope-mismatch`. Authentication, budget and cancellation use the existing codes.
  - There is never a retry until green. A failed comparison is an assertion failure, not by itself a confirmed defect.
  - Keys and values stay in memory; evidence keeps record positions, API value types, verdicts and reasons. Value lengths are not kept: for a short enumeration such as a status, the length alone can reveal the value (found while reviewing the demo evidence: "pending" vs "paid").
- **Verified by:** `tests/checks/consistency.test.ts` and `tests/server/api-observation-ui.test.ts`.

## D9. Cache hits and revalidation (Phase 13.1, observed in the installed version)

- **Source:** probes against Playwright 1.62.1 / Chromium 151.0.7922.34 on this machine (2026-10-06).
  - A memory-cache hit (`Cache-Control: max-age`) reported `responseBodySize: -135`, which is the header estimate subtracted from zero bytes received.
  - A 304 revalidation surfaced to the page as status 200 with `responseBodySize: 0`, `Content-Length: 5027`, and a 5 027-byte body from the cache.
- **Decision:** received bytes bound the body only when bytes were actually received for it.
  - A non-positive body size is `body-size-unknown`.
  - A declared Content-Length that differs from the bytes received is `body-size-mismatch`.
  - Both are metadata only, and `body()` is never called.
- **Limitation:** other browser paths (prefetch caches, back/forward cache, partial content) were not probed. Any of them that reports a positive received size equal to its declared length would be trusted, and the post-acquisition length check is the last guard.
- **Verified by:** "never reads a cached or revalidated body".

## D10. Re-observation outcomes (Phase 13.1)

- **Finding:** in Phase 13, `not-reproduced` was unreachable. A changed value was always classified first as `data-changed`, and identical values always reproduce the same verdict.
- **Decision (`classifyReproduction`):**
  - `not-reproduced`: a record that differed the first time is not matched in the second observation.
  - `data-changed`: the same records are matched, but a value changed on either side.
  - `fail`: the same records and values, still different.
  - In every case the first observation's mismatch stays in the attempts and is never rewritten as a pass.
- **Verified by:** "classifies a re-observation as reproduced, changed data, or not reproduced".

## D11. Stage B: proposals from an executed check

- **Decision:**
  - A structure-only check's evidence records `profileId`, `origin`, `checkId`, the check's definition hash, the body shape (names and types), `emptyArrays` and omissions.
  - The ledger records the sha256 of each evidence file as written.
  - Proposals are built from that file only after its digest, profile, origin and current definition hash all match. No request is sent.
  - Only named top-level fields with one type are proposed, from one response ("1/1").
- **Verified by:** `evidence-drafts.test.ts`.
