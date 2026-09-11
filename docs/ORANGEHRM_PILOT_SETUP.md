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
