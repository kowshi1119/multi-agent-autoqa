# Phase 4 corrective-pass review — 14 September 2026

The new changes make progress, but the claims that review sections 1 and 6 are complete are premature. This addendum concerns the navigation/preflight changes in the latest attachment, not a fresh audit of every Phase 4 component.

Independent verification: typecheck passed; the three affected test files (action-policy, navigation-guard, and preflight doctor) passed **49/49 tests** in 14.66 seconds. These are targeted results, not a full-suite pass. Two additional loopback-only probes exposed missing acceptance cases. No live provider was called, no implementation was edited, and no Git staging/commit/push occurred.

## P1: HTTP redirects bypass the navigation policy

The new comment in [navigation-guard.ts](<C:/Users/ADMIN/Desktop/multi auto QA/src/safety/navigation-guard.ts:97>) says context routing intercepts every redirect hop. The actual installed browser behavior contradicts that assumption.

I ran real Chromium against a disposable local server with this profile scope:

- Allowed origin: the local server.
- Allowed paths: `/allowed`.
- Start: `/allowed/start` responds with HTTP 302, Location `/blocked/destination`.
- Installed the current `installRouteGuard` using the current `ActionPolicy`, plus `installAsyncRedirectGuard`.

Observed:

| Measurement | Result |
|---|---|
| Server requests | `/allowed/start`, `/blocked/destination` |
| Policy checks | `/allowed/start` only |
| Final browser path | `/blocked/destination` |
| Forbidden endpoint received request | **Yes** |

The direct native-form fix and removal of the document asset exemption are useful, but neither prevents this redirect bypass. The async redirect guard checks origin, so it also does not revert this same-origin forbidden path. Even a later revert would not undo a request already sent.

Playwright's [page routing documentation](https://playwright.dev/docs/api/class-page#page-route) explicitly notes that the handler is called only for the first URL when the response redirects. The local probe establishes the behavior of this project's context-routing implementation independently of that documentation.

Required acceptance: a real local-server test must observe **zero hits** on a forbidden destination after an allowed initial request. Cover same-origin forbidden paths and off-origin destinations, plus 302 and method-preserving 307/308 redirects. Verify the selected interception approach empirically; do not rely on request-event visibility or post-navigation correction as proof of preventive blocking. Correct the inaccurate source comment and completion claim.

## P1: Preflight still ignores allowed path prefixes

[doctor.ts](<C:/Users/ADMIN/Desktop/multi auto QA/src/preflight/doctor.ts:120>) now checks origin consistency before fetching and uses `redirect: "manual"`. Both changes are improvements. However, scope consistency still does not check `allowedPathPrefixes`.

I ran preflight against another disposable local server with an owned-sandbox profile, mock providers, an allowed local origin, `allowedPathPrefixes: ["/allowed"]`, and target `/outside-scope`.

Observed:

| Measurement | Result |
|---|---|
| Server requests | `/outside-scope` |
| Scope check | `pass` |
| Target check | `pass` |

Therefore, section 6 is only partially fixed. Validate the target's authorized path before issuing its request, with explicitly scoped authentication exceptions where necessary. Add a test asserting zero destination-server hits for a forbidden path on an otherwise allowed origin. Keeping reachability redirects unfollowed is a valid bounded design; describe a 3xx result as response/reachability evidence, not proof of successful authenticated application access.

## Other status observations

- The current RunManager still checks `this.current`, awaits preflight, then assigns the active run. The concurrency fix is not yet implemented in the inspected source. The attachment ends as that work is starting; the small import/type edit is not its completion.
- Section 1's broader workflow-policy work is also not closed: unknown in-scope fills remain allowed, direct navigation lacks the link-click workflow check, and planner filtering still needs the declared policy.
- This pass does not establish completion of redaction, live authorization, per-request budgets, replay, cancellation, profile UI, or the real-app pilot. Keep each original review item tracked until its acceptance evidence exists.

Next action for Claude Code: reopen sections 1 and 6, add the two server-hit regression cases above, fix the actual transport/path-scope boundaries, then continue the remaining original corrective work. Preserve the passing direct-navigation/form and preflight tests, but do not treat their count as proof of scenarios they do not exercise.
