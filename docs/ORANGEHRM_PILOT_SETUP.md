# OrangeHRM pilot setup (Phase 4 Milestone C)

Status: **live-pilot acceptance PENDING**. This document records what was
checked, what's needed to actually run the pilot, and exactly what's
blocking it in this environment — not a claim that the pilot has run.

## Environment check (done first, before any Milestone A/B work)

Checked in this environment:

```
docker --version        -> command not found (exit 127)
docker-compose --version -> command not found (exit 127)
docker compose version   -> command not found (exit 127)
php --version            -> command not found
mysql --version          -> command not found
```

Neither Docker nor a native PHP/MySQL install path is available. This is
a hard environment limitation, not a configuration problem to work around.
Per the phase's own guidance, this does not block the rest of the
phase — Milestones A, B, and D proceed independently, and this milestone
ships its adapter/profile/reporting machinery complete and tested against
synthetic data, with the actual live run marked pending.

**Re-checked 2026-09-15**: identical result — `docker`, `docker-compose`,
`php`, `mysql` all still absent from PATH. No privileged software was
installed to work around this (per instruction); everything else this
pass could prepare independently (the `allowedFormSubmitEndpoints` fix,
the declared-workflow manifest) is done and disclosed above.

## What a real run needs

**Target**: a dedicated, self-hosted OrangeHRM instance with synthetic
data — never `opensource-demo.orangehrmlive.com` or any other public
hosted demo (a public demo is not a substitute for permission to test
it).

**Setup options** (neither exercised here, for the reason above):

1. **Docker** (`orangehrm/orangehrm-os-dev-environment` on GitHub). This
   repo is an explicit multi-version development matrix with no single
   default combination and no documented one-command quick-start — even
   with Docker available, a specific version/compose-file combination
   must be chosen deliberately before this becomes a one-command bring-up.
2. **Native LAMP-stack install** (PHP + MySQL/MariaDB + the official
   OrangeHRM installer from `orangehrm/orangehrm` on GitHub) — the
   alternative to Docker or a self-hosted install without containers.

Whichever path is used, pin an exact version/revision and record it
(this document, and `docs/PHASE4_ACCEPTANCE.md` once a live run happens),
document the runtime/install method, note that data is synthetic/seeded
(never real personal data), and record the specific test-account role
created for the pilot. Keep the OrangeHRM install's own source/data
entirely separate from this repository.

## Profile

`profiles/orangehrm.json` is the adapter — pure profile data (locators,
URLs, limits) consumed by the generic `FormLoginBootstrap`/`ActionPolicy`
machinery built in Milestone A; there is no OrangeHRM-specific branching
anywhere in the Planner, Validator, or any oracle. Its `target.url`,
`auth.loginUrl`, and locator fields (`usernameField`/`passwordField`/
`submitControl`/`authenticatedSignal`) are currently **placeholders**
based on OrangeHRM's publicly documented, stable login-page structure —
confirm and adjust them once a real instance is reachable; `npm run
doctor -- --profile orangehrm` will report a named `target-reachable`
failure until then, which is the correct, honest result, not a bug.

**2026-09-15 fix, disclosed placeholder**: `resources.allowedFormSubmitEndpoints`
now declares `POST /web/index.php/auth/login` — the login form's own POST
target must be explicitly allowlisted here, same as any other real-target
form submit, because `installRouteGuard()`'s network-layer policy applies
to the login request itself (login is deliberately not exempt from it —
"authentication exceptions remain narrow" per the original review). This
was a genuine, previously-undiscovered bug: without this entry, a real run
against this profile would have its own login denied by its own policy,
regardless of correct credentials. The exact pathname is OrangeHRM's
publicly documented login-form action, same confidence level as the other
locator placeholders above — confirm it once a real instance is reachable.

## Intended workflow set (once reachable)

Start with login → dashboard (this is the positive-control expectation:
on an unmodified OrangeHRM instance, zero genuine findings is a valid
result, not a failure of the tool). Expand to 3–5 pages that are
confirmed to actually exist in the installed version — likely candidates
are the employee list/directory and the leave list — covering roughly
5–10 verified safe workflows: navigation, search, filter, sort,
pagination, and reload where supported. Discover what actually exists;
report a documented module that isn't present in the installed version as
**unavailable**, never as a defect. At most a few bounded runs; do not
measure success by finding a required number of bugs.

**2026-09-15 fix: this is now a real, machine-readable manifest**, not just
prose — `profiles/orangehrm.workflows.json` (see `src/pilot/workflow-
manifest.ts` for the schema) declares exactly the 5 pages and 10 workflows
described above, each with preconditions/authorized-actions/expected-
outcome text. This is the concrete "prepare a pinned setup and workflow
list" deliverable, completed independently of the environment blocker
below — it has NOT been run (the target isn't reachable), so every
workflow's status remains unrecorded until a real run happens. When a real
instance becomes reachable, a human records each workflow's outcome
(attempted/completed/blocked/unsupported) via `saveWorkflowStatus()`
(mirrors `src/human-review/triage.ts`'s exact per-run JSON-file pattern),
and `pilot-summary.json`'s new `declaredWorkflows` field aggregates the
counts — kept entirely separate from `heuristicCoverage`, never conflated.

## Acceptance still pending

- [ ] An OrangeHRM instance is actually reachable (Docker or native
      install — currently blocked, see above)
- [ ] `npm run doctor -- --profile orangehrm` reports READY
- [ ] `profiles/orangehrm.json`'s locators verified/corrected against the
      real instance
- [ ] Preflight → deterministic login → safe exploration → authenticated
      fresh-context replay → report delivery all demonstrated on the
      actual instance
- [ ] A real captured issue replayed, or (if none exists) a clearly
      labeled controlled/injected-fault scenario demonstrated in addition
      to the ordinary pilot run
- [ ] Target/version/pages/workflows/failures/replay outcomes/grouped
      findings/human-review state/duration/limits recorded via
      `src/reporting/pilot-report.ts`'s `buildPilotSummary()`
- [ ] `profiles/orangehrm.workflows.json` (5 pages / 10 declared
      workflows — **prepared, 2026-09-15**) actually run, with each
      workflow's real attempted/completed/blocked/unsupported status
      recorded via `saveWorkflowStatus()`; `pilot-summary.json`'s
      `declaredWorkflows` field shows real counts, not `{manifestPresent:
      false}`
