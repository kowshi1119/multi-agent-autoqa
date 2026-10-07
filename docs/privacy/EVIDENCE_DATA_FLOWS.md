# Evidence data flows (Phase 14, 2026-10-07)

This inventory drove the Phase 14 changes. It was built from the code and synthetic fixtures only; no real-application artifact was read into it.

**Legend**
- **Minimal**: the behaviour under `evidence-policy/1` minimal mode, the default for every non-fixture target.
- **Diagnostic**: the previous behaviour, kept for local fixtures and for profiles that opt in.

| Flow | What enters | Needed to execute? | Persisted / transmitted | Controls before Phase 14 | Minimal mode now |
|---|---|---|---|---|---|
| Browser observation (`browser/observation.ts`) | Control names and labels (aria-label, `<label>`, placeholder, 120 characters of text), link text and hrefs, title, visible text | Yes, in memory (planning, locating, assertions) | Into the map, findings, model input | `redactSecrets` at capture (credentials only) | Unchanged in memory; reduced wherever written (rows below) |
| Application map (`mapping/mapper.ts`) | Pages: URL with query, title, controls, links | Count only (`assemble.ts`) | `application-map.json` (**no redaction**), `report.json` | None / `redactSecrets` | Run-local refs (`P1.C3`, `P1.L2`), roles, widget types, route templates, counts; titles, names, labels, hrefs, queries and fragments omitted |
| Findings (`report.ts`, `evidence.ts`) | URL, steps (names, fill values), controlKey, oracle text, critic text, visible text, console, page errors, network URLs | Replay uses the in-memory finding | `findings/<id>/*.json`, `report.json`, `report.md` | `redactSecrets` | `finding.json`: IDs, fixed title, statuses, route template, step type/role, reproduction counts. `oracle.json`: oracle ID. Console and page errors: counts and error classes. Network: method, template, status. `visible-text.json` not written. Critic: verdict and confidence |
| Screenshots and traces (`observation.ts:361`, `browser.ts:247`) | Pixels; DOM, network and sources (trace) | No | `screenshot.png`, `trace.zip` | Screenshots on for every profile; traces fixture only | **Not captured** (JSON minimization does not reach image or trace contents) |
| Workflow records (`pilot/workflow-runtime.ts`) | Assertion expected/observed, full URL, steps, reset detail | Verdicts | `workflows/<id>.json` and copies in suite, coverage and qa-summary | `redactSecrets` | Expected (approved configuration) kept; observed query and input values become "matches/differs (value omitted)"; URL and paths become templates; steps become type and role |
| Run log (`logger.ts`) | Step targets, oracle results, URLs, stacks, model intents | No | `run.log` | `redactSecrets` per argument | Field allow-list (IDs, states, codes, counts); other field *names* listed under `omittedFields`; URLs inside messages masked |
| Progress events (`run-manager.ts` emit → SSE, `/status`) | Candidate descriptions, model intent, oracle text, stacks | No | Browser UI | **None** | Phase-level text; AutoQA's own fixed texts and authored stop reasons kept; the "→ action" marker kept without description |
| Run summary (`report.ts:170`, `run-manager.ts` fallback) | Target URL (configuration), stop reason (may hold a stack) | No | `run-summary.json` | **None** | Stop reason reduced to its code unless AutoQA wrote the text itself |
| API checks (`run-api-checks.ts`) | Response bodies | Assertions in memory | `checks/<id>/response.json`, finding evidence | Structure-only only when declared | Structure-only forced: status, media type, body shape |
| Security checks (`run-security-checks.ts`) | Headers, 2 000-character body excerpt | Assertions | `checks/<id>/response.json` | `redactStructuredEvidence` | Body excerpt omitted; headers kept (they are what is assessed) |
| API observation (`auth/api-observer.ts`) | Structure only (Phase 13) | No | `api-observations.json` | Vocabulary masking | Unchanged |
| Artifact serving (`server/routes/artifacts.ts`) | Any run file | — | HTTP to the local browser | Path containment and realpath; **GET skipped the Host check** (DNS-rebinding read, reproduced by a test) | Host check on every request; exports downloaded with `Content-Disposition: attachment` |
| Export (`reporting/export.ts`, new) | Allow-listed fields of known artifacts | — | `runs/<id>/exports/<EXP>/export.json`, `.md` | No export existed | Projection only; binary and unknown types excluded; symbolic links and junctions never followed; no absolute paths |
| Model providers (`explorer.ts`, `critic/schema.ts`) | Explorer: 1 500 characters of visible text, candidates, URL, title. Critic: 500-character excerpt, console and errors | Live explorer and critic only | Sent to the configured provider | Demo mode forces mocks (`run-manager.ts`); the CLI needs `--live` | **Unchanged, unresolved boundary.** A live provider still receives page text. Out of scope for Phase 14 |

## Remaining

- **Live-model input:** a live provider still receives page text (see the last row).
- **Approved configuration text:** declared targets and descriptions stay in local files. Exports include them only when "Include approved configuration labels" is ticked.
- **Legacy runs:** runs written before Phase 14 keep their original content. Exports label them privacy-unclassified and include no observed text.
