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

Fixes any ✗ before continuing (e.g. `npx playwright install chromium` if
Chromium isn't launchable). "Target reachable" will show ✗ until you
start the fixture — that's expected here; the UI/CLI start it for you.

## 3. Run the control panel

```bash
npm run ui
```

Open `http://localhost:4180`.

1. **Choose a project** — pick the `fixture` profile (or `orangehrm` once
   you have a reachable instance — see `docs/ORANGEHRM_PILOT_SETUP.md`).
2. **Check setup** — review the pass/fail list; a ✗ tells you the exact
   next step.
3. **Sign in for this run** — only shown if the profile requires a login;
   never saved.
4. **Mode** — leave "Demo" selected (deterministic, no live model calls)
   unless you specifically intend a live run with real limits confirmed.
5. **Start** — watch live progress (pages visited, actions, remaining
   budget, reportable issues). **Stop** halts the run cleanly at any
   point.
6. **Results** — grouped issue cards (Reportable / Needs Review /
   Suppressed / Not Reproduced), each showing reproduction counts,
   evidence completeness, and the critic's verdict. Prior runs are listed
   below and reopenable.

## Command-line equivalent

```bash
npm run qa -- --config qa.config.mock.yaml
```

Artifacts land in `runs/<run-id>/` (`report.json`, `report.md`,
`run-summary.json`, per-finding evidence).

## Advanced

- Full config reference: see README.md.
- Real-application pilot setup: `docs/ORANGEHRM_PILOT_SETUP.md`.
- Everything built/verified this phase: `docs/PHASE4_ACCEPTANCE.md`.
- Full running history: `PROGRESS.md`.
