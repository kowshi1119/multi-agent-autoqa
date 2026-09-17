# Gemini Explorer integration: review and implementation

## Assessment

**Plan rating: 8/10.** Strong provider isolation, evidence controls, security requirements, and regression strategy. The original proposal overstates the implemented providers and assumes a browser-agent/MCP/visual-results contract that this repository does not have. The user's later request authorized implementation after review.

This change adds an optional **text/DOM Gemini Explorer**. It does not claim screenshot reasoning, Ajeer acceptance, or live model validation.

## 1. Current architecture found

`runPipeline` composes providers in `ModelRouter`, creates the browser, and runs the existing deterministic orchestrator. Working providers are mock, Anthropic, and Explabs. OpenAI and Ollama remain explicitly unimplemented configuration choices. `.claude/launch.json` exists; no project skill or instruction files were discovered in the inspected tree.

## 2. Existing provider interface

`ExplorerProvider.decideNextAction(ExplorerInput, AbortSignal?)` returns the existing `ExplorerDecision`: candidateId, testingIntent, reason. The Critic has a separate interface. No new execution-result or bug-verdict model is needed.

## 3. ModelRouter flow

`selectProvider` constructs Gemini only when explicitly configured. `ModelRouter` remains simple composition. Existing `auto` selection still resolves Anthropic or mock; merely adding a Gemini key does not change it.

## 4. Browser execution flow

Planner builds candidates; Explorer chooses one; the executor performs the approved actions with Playwright. Oracles, clean-session reproduction, Critic disposition, and grouping remain downstream. Model prose never becomes recorded browser evidence.

## 5. Proposed and implemented Gemini architecture

`selectProvider -> GeminiModelProvider -> GoogleGenAI.models.generateContent` feeds the same Explorer/Orchestrator path. The model receives sanitized observation text and candidate descriptions, not browser handles, arbitrary tools, images, or file access. Gemini is Explorer-only; the Critic schema rejects Gemini.

## 6. Existing files modified

| File | Current responsibility | Change and reason | Risk |
| --- | --- | --- | --- |
| `src/config.ts` | Shared model configuration | Add Gemini to Explorer enum only | Low |
| `src/models/provider-credentials.ts` | Credential resolution | Resolve GEMINI_API_KEY for Explorer | Low |
| `src/run-pipeline.ts` | Provider construction/pipeline composition | Construct Gemini with existing budget/usage and timeout settings | Medium |
| `src/redact.ts` | Shared secret scrubbing | Cover Gemini environment key and standard Google API-key shape | Medium |
| `src/provider-check.ts` | Credential diagnostic | Add --config and redact displayed model/errors | Low |
| `package.json`, `package-lock.json` | Dependency contract | Pin official SDK and its resolved dependencies | Medium |
| `.env.example` | Credential template | Document empty GEMINI_API_KEY | Low |
| `README.md`, `PROGRESS.md` | Project documentation | Explain scope and link this guide | Low |

Existing working-tree edits were preserved. No private profiles or default run configuration were changed.

## 7. New files

- `src/models/gemini-provider.ts`: isolated SDK adapter, strict decision validation, safe errors, bounded repair, usage accounting.
- `tests/models/gemini-provider.test.ts`: real SDK with intercepted HTTP; configuration, routing, schema, budgets, timeout, cancellation, and redaction.
- `tests/models/gemini-pipeline.test.ts`: real Chromium/local-fixture execution plus production report writing with intercepted Gemini transport; diagnostic subprocess test.
- `qa.config.gemini.yaml`: explicitly selected local-fixture example with small request/action/time limits and mock Critic.
- `docs/GEMINI_PROVIDER.md`: this review, implementation record, and usage guide.

## 8. Configuration

Set `GEMINI_API_KEY` privately in the local environment. The integration does not introduce GEMINI_MODEL or BROWSER_EXPLORER_* overrides: use existing `models.explorer.model` in YAML or `provider.explorer.model` in a profile. This avoids conflicting configuration sources.

The optional example uses `gemini-3.5-flash`, a stable model listed in [Google's model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash). Availability for the user's key remains unverified. No default model is silently chosen by the adapter.

Check configuration without a model request:

```powershell
npm run provider:check -- --config qa.config.gemini.yaml
```

Only when deliberately authorizing a billed local-fixture smoke run:

```powershell
npm run qa -- --config qa.config.gemini.yaml --live
```

The diagnostic's own `--live` path remains Explabs-only; it is not a Gemini ping. For a profile, use the existing local UI and its explicit Live/confirmed-limits flow. Do not switch Ajeer to Gemini as part of this change.

## 9. Dependencies and official sources

Pinned `@google/genai` 2.23.0, compatible with the project's Node >=20 declaration. Google's [SDK guide](https://ai.google.dev/gemini-api/docs/libraries) recommends this package; the older `@google/generativeai` package is not used. Installation skipped lifecycle scripts. SDK retries are explicitly disabled with attempts: 1, which includes the original request, per [HttpRetryOptions](https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpRetryOptions.html).

## 10. Types and schemas

Reuse `ExplorerInput`, `ExplorerDecision`, and `explorerDecisionSchema`. Apply strict validation at the Gemini boundary. The small JSON wire schema has exactly the same three fields and dynamically limits candidate IDs to the displayed candidates plus stop. Additional verdict/evidence/action fields are rejected.

## 11. Explorer integration

No new agent. Gemini chooses existing approved candidates. The adapter includes the existing system instruction and treats application content as untrusted. It neither interprets absent test-case contracts nor claims unexecuted steps completed.

## 12. Playwright and MCP

No second browser stack and no Gemini tool execution. Google supports [function calling](https://ai.google.dev/gemini-api/docs/function-calling) and [image inputs](https://ai.google.dev/gemini-api/docs/image-understanding), but those capabilities are not wired into this integration. Screenshot input needs a separately designed, sanitized, consent-aware shared observation contract. Existing screenshot evidence policy remains unchanged.

## 13. Structured output

Use application/json and responseJsonSchema through generateContent, then validate locally. Google's [structured-output documentation](https://ai.google.dev/gemini-api/docs/generate-content/structured-output) describes schema-constrained generation; server-side schema enforcement is not substituted for local checks. Malformed or unoffered decisions get at most one repair containing the original sanitized context and a fixed correction instruction. Raw invalid output is never echoed or logged. Persistently invalid output uses existing ModelOutputInvalidError handling.

## 14. Error handling and accounting

Missing key/model fails before a request. GeminiProviderError exposes fixed `LLM_PROVIDER_ERROR` messages for authentication, quota/rate limit, model-not-found, invalid request/context-size, unavailable service, timeout, cancellation, blocked response, unexpected response, or initialization. Raw SDK errors, bodies, and causes are discarded. Provider errors fail the run through the existing pipeline; they do not create application findings.

Request budgets are reserved at each actual SDK call, including repair. No automatic retries or fallback. Cancellation reaches the real transport. A decision-wide timeout bounds first call plus repair; the upstream run deadline also applies. Usage includes prompt tokens and candidate plus thinking output tokens where reported. Missing usage stays unknown. No monetary rate was invented.

## 15. Security considerations

The endpoint is fixed to Google's Gemini Developer API, with Vertex routing disabled; ambient SDK endpoint variables cannot redirect the configured credential. Prompts, returned rationale, logs, and report artifacts use secret scrubbing. Auth credentials remain transient and existing live-mode authorization remains mandatory. Tests use fake keys and intercepted transport only. Redaction is defense in depth, not a claim that arbitrary screenshots are sanitized; images are not sent by this adapter.

## 16. Testing strategy

The new 30-test set covers actual SDK request mapping, strict output handling, unoffered IDs, first-25 candidate boundary, repair context, request budgets, HTTP error mapping/no hidden retries, timeout, cancellation, missing usage, thinking-token accounting, secret redaction, profile mapping, provider selection, unchanged auto/live gates, and explicit Gemini-Critic rejection. Pipeline tests open real local Chromium and verify both one executed navigation and a provider outage with zero invented findings. Reports and diagnostic output are checked for the fake key.

## 17. Regression risks

SDK/version changes, future decision-contract changes, and application compatibility remain risks. The fixed wire-schema and SDK transport tests cover integration drift. Full regression validation is recorded below. Screenshot reasoning, provider fallback, and live-response quality are explicitly unverified/deferred.

## 18. Implementation order

Inspection and official-source verification -> dependency -> configuration/credentials/redaction -> isolated adapter -> routing -> offline adapter tests -> real local-browser integration with intercepted SDK -> documentation -> full regression suite.

## 19. Rollback

Operational rollback: select the prior Explorer provider/configuration. No data migration or private profile rewrite is needed. For code rollback, remove only this integration's additions and dependency, preserving all pre-existing working-tree changes. Do not reset the working tree wholesale.

## 20. Acceptance

- Implemented: optional Gemini Explorer, environment credential, explicit model, shared router/execution, strict output, safe errors, budgets/cancellation, new tests and documentation.
- Preserved: existing providers' behavior, Critic/oracle/reproduction responsibilities, live-call authorization, default configurations, and user changes.
- Deferred: live Gemini call, screenshot reasoning, Gemini Critic, failover, and Ajeer pilot acceptance.
- Targeted verification: typecheck and all 30 new tests passed.
- Full regression verification: build and typecheck passed; `npm test` passed all 580 tests in 68 files (210.97 seconds), including all 30 new Gemini tests. Verification used intercepted Gemini HTTP only; no live Gemini request or Ajeer run was performed.

READY FOR IMPLEMENTATION: YES — the scoped Explorer implementation is now present. Live deployment/paid validation is not part of this acceptance.
