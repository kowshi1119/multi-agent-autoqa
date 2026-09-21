# Local (no-cost) Explorer research and decision — 2026-09-21

Budget for this work: zero. No paid API, cloud resource, or subscription may be used. Disk space is tight — the user explicitly declined to have Ollama installed or any model downloaded in this pass, regardless of whether it would technically fit. That instruction is a hard boundary here, not a recommendation this document argues against.

## Hardware and runtime facts (rechecked live, not assumed from an older observation)

- OS: Windows. CPU: Intel Core i5-6500T, 4 cores. GPU: Intel HD Graphics 530 (no useful local-inference acceleration).
- RAM: 16,637,384 KB total (~15.9 GB), 4,356,892 KB free (~4.2 GB) at time of check — memory is genuinely constrained under current load, not just disk.
- Disk: 16 GB free on C: (`df -h /c` → `16G avail`, 87% used).
- `ollama` is not on PATH — not installed.
- Node v24.19.0, npm 11.17.0.

## Sources consulted (accessed 2026-09-21)

- https://docs.ollama.com/windows — install size and platform requirements.
- https://docs.ollama.com/api/chat — request/response contract for `/api/chat`.
- https://docs.ollama.com/capabilities/structured-outputs — the `format` field and JSON-schema support.
- https://github.com/ggml-org/llama.cpp/tree/master/tools/server — considered as the fallback runtime (see below), not fetched in depth because Ollama was selected first.

### What the docs say

- **Windows footprint**: "You'll need at least 4GB of space for the binary install." Models are additional and stored under `%HOMEPATH%\.ollama` by default (or `OLLAMA_MODELS`); a small instruct model in the 0.5–1.5B range is realistically ~0.4–1.5 GB, not the "tens to hundreds of GB" figure the docs quote for large models. On this machine's 16 GB free, that would technically fit (~5–6 GB total, leaving ~10 GB) — **this is recorded for completeness only; it is not authorization to install anything.** GPU is optional; CPU-only inference is a supported configuration, which matters here since there is no usable local GPU.
- **`/api/chat` contract**: `POST {baseUrl}/api/chat` with `{model, messages, stream, format, options}`. `format` accepts a full JSON Schema object (not just the string `"json"`), which lets the existing `explorerDecisionSchema`-shaped constraint be requested directly, matching the pattern already used by `GeminiModelProvider`. Response includes `message.content` plus timing/token fields: `total_duration`, `load_duration`, `prompt_eval_count`, `prompt_eval_duration`, `eval_count`, `eval_duration` (all nanoseconds/counts). No documented native request timeout or cancellation mechanism at the HTTP layer — the adapter uses the standard `fetch` `AbortSignal`, exactly like every other provider in this codebase.
- **Structured outputs**: recommend `temperature: 0` for determinism; recommend also stating the schema in the prompt text for grounding (not required for validity, but improves reliability) — not adopted here since the existing `EXPLORER_SYSTEM_PROMPT`/`formatUserMessage` contract is reused unchanged, matching how `GeminiModelProvider` does it.

## Decision: Ollama, not llama.cpp

The project already has Ollama-shaped scaffolding in place before this work started: `OLLAMA_BASE_URL`/`OLLAMA_MODEL` in `.env.example`, `"ollama"` already a valid `modelsSchema` enum value, and `provider-check.ts`'s `credentialStatus()` already treating `"ollama"` as needing no credential. Implementing against llama.cpp's server instead would mean introducing a second, unscaffolded runtime with no demonstrated advantage for a small instruct model — this violates "do not introduce technology merely because it is new." Ollama is the implemented path; llama.cpp was not pursued.

## Model recommendation (not installed by this work)

A small 0.5–1.5B instruct model, quantized (e.g. the `qwen2.5:0.5b-instruct` class) — chosen only as a *starting point recommendation*, never pulled or verified by this pass. Before the user installs anything, they should independently verify: current availability under that exact tag, the model's actual license terms, and real memory/CPU behavior on this specific machine — none of that is assumed here. A larger model is a later experiment, not a prerequisite for the adapter to be useful or correct.

## What was implemented (offline, no install required)

- `src/models/ollama-provider.ts` — `OllamaModelProvider implements ExplorerProvider`, plus `assertLocalOnlyUrl()` (rejects any non-loopback host, any non-`http:` scheme, and any redirect response instead of following it off-loopback).
- Wired into `src/run-pipeline.ts`'s `selectProvider()` — `"ollama"` removed from `UNIMPLEMENTED_PROVIDERS` (only `"openai"` remains blocked); `OLLAMA_BASE_URL` read directly (it's local-adapter configuration, not a secret, so it doesn't go through `resolveProviderCredential`'s `(provider, role) -> secret` shape).
- `tests/models/ollama-provider.test.ts` — 24 tests against a fake `fetch`, covering: valid decision round-trip, one budgeted repair, invented/authority-expanding output rejection, the >25-candidate boundary, budget exhaustion, cancellation, timeout, connection-refused vs. 404-model-missing error taxonomy, redirect refusal, missing-token-usage handling, and transient-secret redaction. No real network access, no running Ollama, no API key.
- `qa.config.ollama.yaml` — a `--live`-gated example config mirroring `qa.config.gemini.yaml`'s tight limits.
- `src/provider-check.ts` — extended `--live` to support `"ollama"` (reachability + model-presence check via `GET /api/tags`, then one bounded `decideNextAction` call) alongside the existing Explabs path. Only reachable once Ollama is actually installed and running.
- `src/experiments/local-explorer-benchmark.ts` (`npm run local-explorer:benchmark`) — a decision-quality evaluation (§8A: schema validity, offered-candidate compliance, appropriate stopping, prompt-injection resistance, latency) over a handful of frozen synthetic `ExplorerInput` cases, run against Mock always and Ollama when reachable. This is explicitly **not** a defect-detection precision/recall measurement.

## Not done in this pass

- **No Ollama install, no model download, no live Ollama HTTP call was ever made.** Confirmed by: `tests/models/ollama-provider.test.ts` passes fully offline; `npm run local-explorer:benchmark` was run once during verification and reported `"skipped: OLLAMA_MODEL not set"` for the Ollama arm.
- No Ollama Critic — the brief explicitly scoped this out; `selectCriticProvider()`'s block on `"ollama"` is untouched.
- No full end-to-end fixture-pipeline benchmark (§8B — comparing raw `run-pipeline` runs through Mock vs. Ollama end to end, with coverage/precision/recall against fixture ground truth). The decision-quality scaffold above (§8A) was prioritized as the smaller, honestly-deliverable piece within this pass's scope; §8B is a reasonable follow-up once real local-model behavior is observed at all.
- No CI wiring, no OrangeHRM/MFA work, no staging/commit/push/PR/deploy.

## Next concrete step (the user's, not this work's)

If/when disk space allows: install Ollama (~4 GB), run `ollama pull <model>` for a small instruct model of the user's choosing (verifying its real size/license first), set `OLLAMA_MODEL` (and `OLLAMA_BASE_URL` if not using the default `http://127.0.0.1:11434`) in `.env`, then run `npm run provider:check -- --config qa.config.ollama.yaml --live` for one bounded real decision, followed by `npm run local-explorer:benchmark` for the small decision-quality comparison against Mock. None of that is required for the rest of AutoQA to keep working exactly as it did before this pass.
