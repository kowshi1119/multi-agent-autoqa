# AutoQA Quickstart

## 1. Install

```bash
npm install
npx playwright install chromium
```

## 2. Check setup

```bash
npm run doctor -- --profile fixture
```

Fix any ✗ before continuing (e.g. `npx playwright install chromium` if
Chromium isn't launchable). "Target reachable" shows `~` (managed) for
the fixture profile, not ✓ or ✗ -- the fixture's server is started
automatically only once a run begins (the UI/CLI do this for you), so
this check is intentionally not probed ahead of time and never blocks
readiness. A real-target profile's "Target reachable" check IS actively
probed and must show ✓ (or you'll be refused at Start, not just warned).

## 3. Run the control panel

```bash
npm run ui
```

Open `http://localhost:4180`.

1. **Choose a project** — pick the `fixture` profile (a safe, deterministic
   demo target bundled with AutoQA) to try things out first. OrangeHRM
   real-application support exists (`docs/ORANGEHRM_PILOT_SETUP.md`) but is
   currently **deferred** — no reachable instance is required or assumed
   for this quickstart. To point AutoQA at your own real target, click
   **New profile**: fill in id/name/target URL and pick an environment kind
   (`owned-sandbox` or `self-hosted-real-app` for anything that isn't the
   bundled fixture — never point AutoQA at a target you don't own or have
   explicit authorization to test), then use the JSON textarea to declare
   the **explicit scope** every real target needs: `navigation.
   allowedOrigins`/`allowedPathPrefixes` (where AutoQA is allowed to go)
   and `resources.allowedApiOrigins`/`allowedFormSubmitEndpoints` (which
   API/form requests it's allowed to make) — anything outside this
   declared scope is denied by default, not just discouraged. This is
   exactly the schema every other profile-reading path uses, so a rejected
   save shows the real validation error inline (e.g. a missing
   `allowedOrigins` entry), not a silent failure. Secrets are never entered
   or stored here — see step 3. Click **Edit profile** to change the
   currently-selected one later.
2. **Check setup** — review the pass/fail list; a ✗ tells you the exact
   next step (e.g. "Could not reach http://... : fetch failed" if the
   target isn't actually up). Starting a run enforces this same check
   server-side, not just in this button -- a genuine ✗ (never `~` managed,
   which is the fixture-only "started automatically" case) refuses the
   start with the specific failing check named. Provider identity and
   limits (explorer/critic model, budgets) are shown in the profile
   dropdown itself before you start anything.
3. **Sign in for this run** — only shown if the profile requires a login;
   never saved to the profile or browser storage.
4. **Mode** — leave "Demo" selected (deterministic, no live model calls)
   unless you specifically intend a live run with real limits confirmed.
5. **Start** — watch live progress (pages visited, actions, remaining
   budget, reportable issues). Refreshing the page mid-run reconnects to
   it — you keep Stop access and the live counters, nothing is lost.
   **Stop** genuinely interrupts whatever AutoQA is doing right now (a
   wait, a navigation, a click, a login step, a replay step) — not just
   "no new step starts" — verified down to the level of an individual
   Playwright call; a cancelled run still keeps everything it found and
   did before Stop (partial findings, action/budget counts), it's just
   labeled "stopped," never "completed."
6. **Results** — grouped issue cards (Reportable / Needs Review /
   Suppressed / Not Reproduced), each showing reproduction counts,
   evidence completeness, the critic's verdict, an inline screenshot, and
   links to every other captured evidence file (console/network/trace).
   Prior runs are listed below (scrollable once there are more than a
   handful) and reopenable.

## Command-line equivalent

```bash
npm run qa -- --config qa.config.mock.yaml
```

Artifacts land in `runs/<run-id>/` (`report.json`, `report.md`,
`run-summary.json`, per-finding evidence).

## Advanced

- Full config reference: see README.md.
- Real-application pilot setup (OrangeHRM, currently deferred by the
  user's own explicit instruction, not attempted or blocked by this
  environment): `docs/ORANGEHRM_PILOT_SETUP.md`.
- Everything built/verified this phase: `docs/PHASE4_ACCEPTANCE.md` and
  `PHASE4_FINAL_ACCEPTANCE.md` (closing acceptance record).
- Full running history: `PROGRESS.md`.
