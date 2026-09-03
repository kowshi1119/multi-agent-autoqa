# AutoQA

## What it is

AutoQA is a prototype of an autonomous QA agent. It opens a real Chromium
browser, lets an AI "explorer" pick one safe action at a time (click, fill,
navigate, etc.), and uses **deterministic, code-based oracles** — not the
AI's opinion — to decide whether something suspicious happened. A suspected
bug is only reported as a finding after it has been **reproduced in fresh,
independent browser sessions**, replaying the exact recorded steps.

This is Phase 0: the smallest end-to-end slice of that idea, built to be
small, readable, and honestly verifiable rather than broad in scope.

## Phase-0 scope

Built: CLI, YAML config + Zod validation, a Playwright browser controller,
page observation (console/network/DOM), a model-provider interface with a
deterministic mock provider and a real Anthropic adapter, a safe structured
action schema + executor with an origin allowlist and prompt-injection
guard, a `console-error` oracle, a clean-context validator that replays
recorded steps 3 times in fresh browser contexts, evidence capture, and
JSON reports (`finding.json`, `run-summary.json`).

Not built (see `## TODO: Phase 1` below): dashboard, database, queues,
CI/CD, multi-agent orchestration, accessibility/visual regression testing,
regression-test generation.

## Architecture

```
CLI
  ↓
Config (qa.config.yaml + Zod)
  ↓
Explorer (AI suggests ONE action; never declares a confirmed bug)
  ↓
Playwright (executes the action, observes the page)
  ↓
Oracle (deterministic code decides: suspicious or not)
  ↓
Validator (replays exact steps in 3 fresh browser contexts)
  ↓
Evidence (screenshot, trace, console/network JSON)
  ↓
Report (finding.json, run-summary.json)
```

**The core rule: the model reasons, code decides.** The AI Explorer may only
suggest an action, describe its testing intent, and observe. It never
declares a confirmed bug. A finding only reaches `validated` status after
all three of: AI-directed exploration + a deterministic oracle +
clean-session reproduction (at least `validation.minimumSuccesses` out of
`validation.attempts` fresh replays reproducing the same oracle result).

## Requirements

- Node.js >= 20 (built and verified on Node v24.19.0)
- npm
- ~300 MB free disk for the Chromium browser binary

## Installation

```bash
npm install
npx playwright install chromium
```

## Configuration

Edit `qa.config.yaml` (never hard-code the target URL into the engine):

```yaml
project:
  name: "AutoQA Demo"

target:
  url: "http://localhost:4173/"
  environment: "local-fixture"   # "local-fixture" auto-starts fixture/server.ts

browser:
  engine: "chromium"
  headless: true                 # forced to true automatically if no DISPLAY
  viewport:
    width: 1440
    height: 900

agent:
  maxActions: 15
  maxModelCalls: 15

validation:
  attempts: 3
  minimumSuccesses: 2

evidence:
  screenshots: true
  trace: true
  console: true
  network: true

safety:
  safeMode: true
  allowedOrigins:
    - "http://localhost:4173"
```

Invalid configuration (e.g. `validation.minimumSuccesses > validation.attempts`,
a bad URL, a non-positive budget) fails fast with a precise error and never
starts a browser or writes a partial run.

## AI provider setup

Copy `.env.example` to `.env` and fill in credentials:

```
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=
QA_USERNAME=
QA_PASSWORD=
```

- If `ANTHROPIC_API_KEY` is set, AutoQA uses `AnthropicModelProvider`.
- Otherwise it automatically falls back to the deterministic
  `MockModelProvider` and says so on the console and in `run-summary.json`
  (`"provider": "mock"`).

**In this build/verification session no provider credentials were
available**, so:

> Infrastructure verified using MockModelProvider.
> Live model integration could not be executed because no provider
> credentials/runtime were available.

`QA_USERNAME`/`QA_PASSWORD` are resolved only at execution time, are never
logged or stored raw, and appear in logs/evidence/prompts only as the
literal placeholder `<QA_PASSWORD>`.

## How to run

```bash
npm run qa
```

This compiles with `tsc` and runs the compiled output with plain `node`
(see "Troubleshooting" for why). It loads `qa.config.yaml`, starts the
bundled local fixture server (since `target.environment` is
`local-fixture`), launches Chromium, lets the explorer take one action,
evaluates the oracle, and — if suspicious — validates and writes evidence.
It always exits cleanly and prints a final summary block.

Use a different config file:

```bash
node dist/src/index.js --config path/to/other.config.yaml
```

## How validation works

1. The oracle flags a suspicious result → a finding is created with
   `status: "suspected"`.
2. The exploring browser context is closed.
3. For each of `validation.attempts` (default 3): a **brand-new** browser
   context is opened, the page is navigated to the target URL, the exact
   recorded `steps` are replayed, and the same oracle is re-evaluated. The
   context is closed afterward regardless of outcome.
4. Reproduction counts are tallied in code (never asked to the model):
   - `successes >= minimumSuccesses` → `validated`
   - `successes === 0` → `rejected`
   - otherwise → `needs_human`

## How evidence works

For a suspected/validated finding, AutoQA writes to
`runs/RUN-<timestamp>/findings/FINDING-00N/`:

- `finding.json` — the full finding, including recorded steps
- `oracle.json` — the oracle result that triggered suspicion
- `reproduction.json` — every validation attempt's result
- `console.json` / `network.json` — from the first validation replay (gated
  by `evidence.console` / `evidence.network`)
- `screenshot.png` — after-replay screenshot (gated by `evidence.screenshots`)
- `trace.zip` — Playwright trace from the first replay (gated by `evidence.trace`)

If an evidence type is disabled in config (or capture fails), it is
recorded under a "skipped" note printed to the console rather than silently
omitted, and left out of `finding.evidence[]`.

`run-summary.json` (at the run root) records counts: actions performed,
model calls, and findings by status. `tokenUsage` is `null` because the
mock provider (used in this run) reports no usage — AutoQA never guesses it.

## Safety model

- **Safe mode defaults to `true`.**
- **Origin allowlist**: an explicit `navigate` action outside
  `safety.allowedOrigins` is rejected before execution, logging exactly
  `Blocked navigation outside allowed origin.`; the page itself can never
  override this.
- **Prompt-injection guard**: the explorer's system prompt states plainly
  that page content is *untrusted application data*, wrapped in
  `<application_observation>...</application_observation>`, and must never
  be treated as instructions.
- **Restricted action schema**: only `click`, `fill`, `press`, `reload`,
  `navigate`, `wait`, `stop` are accepted (Zod-validated); no arbitrary
  JavaScript, `eval`, shell commands, or filesystem access is ever exposed
  to the model.
- **Secrets**: `QA_PASSWORD`/API keys are never logged, stored in evidence,
  or included in prompts; password values are redacted to `<QA_PASSWORD>`.
- **Agent mistakes vs. app defects**: a locator that can't be resolved is
  classified as `AGENT_ACTION_FAILED`, never as an application defect.

## How to run tests

```bash
npm test
```

Runs Vitest over `tests/` — configuration validation, action schema/origin
checks, the console-error oracle's before/after diffing, and the
validator's success-count decision rule. No network calls, no paid model
calls.

## Troubleshooting

- **`AutoQA could not start Chromium.`** — run
  `npx playwright install chromium` (or `npx playwright install --with-deps
  chromium` on Linux, which also installs OS-level dependencies).
- **`ReferenceError: __name is not defined` inside `page.evaluate`** — this
  happens if you run the TypeScript source directly through `tsx`/`esbuild`;
  esbuild's `keepNames` transform injects a helper call inside the
  `page.evaluate()` closure that doesn't exist once Playwright serializes
  and re-runs that closure inside the browser page (a separate JS realm
  with no access to the Node-side bundle's helpers). That's why `npm run
  qa` compiles with plain `tsc` first and runs the output with plain
  `node`, which performs no such transform.
- **`AutoQA configuration error`** — the message names the exact field and
  rule that failed; fix `qa.config.yaml` and re-run.
- **`AGENT_ACTION_FAILED: the requested locator could not be resolved.`** —
  the explorer asked for an element that isn't on the page. This is an
  agent/tooling mistake, not an application defect, and AutoQA continues
  (within remaining budget) rather than reporting it as a finding.
- **Headless mode looks wrong** — headless is forced to `true` whenever the
  `DISPLAY` environment variable is absent, regardless of
  `browser.headless` in config; the run banner logs which mode was chosen
  and why.

## Known limitations

- **Live model integration was not executed.** No `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / reachable Ollama instance was available in this
  environment; the full pipeline (browser, fixture, oracle, validator,
  evidence, reports) was verified end-to-end using `MockModelProvider`
  only. `AnthropicModelProvider` is implemented against the same
  `ModelProvider` interface but has not been exercised against the live
  Anthropic API in this session.
- Only one oracle (`console-error`) is implemented; a duplicate-POST oracle
  was intentionally left out to avoid delaying the primary acceptance flow
  (see `## TODO: Phase 1`).
- The origin allowlist gate is enforced for explicit `navigate` actions
  only; an in-page link that happens to navigate off-origin as a side
  effect of a `click` is not separately intercepted in Phase 0.
- The `qa` command's own final console summary does not print `Tests:` /
  `Typecheck:` PASS/FAIL lines, since a single `npm run qa` invocation
  doesn't run the test suite or the type checker itself — run `npm test`
  and `npm run typecheck` separately (both documented above).
- The fixture always logs exactly one seeded console error per submit; it
  does not model more complex/intermittent bugs.
- `npm audit` reports vulnerabilities in `esbuild`/`vite`, transitive
  dev-only dependencies of Vitest's dev-server (not used at runtime, not
  reachable from network in normal `npm test` usage). Left unpatched to
  avoid an unrelated breaking upgrade to Vitest 4 in Phase 0.

## TODO: Phase 1

- Multi-agent orchestration and agent-to-agent messaging
- Dashboard (React/Next.js), Chrome extension
- Persistent storage (PostgreSQL/pgvector), job queue (Redis/BullMQ)
- CI/CD integration (GitHub Actions), Jira integration
- Multi-user authentication
- Full accessibility engine (axe), visual regression testing
- Regression-test generation from validated findings
- Cross-browser grid (Firefox/WebKit)
- A second oracle (e.g. duplicate-POST detection) and richer seeded-bug
  fixtures covering more defect classes
- Origin-allowlist enforcement on in-page navigations triggered by clicks,
  not just explicit `navigate` actions
