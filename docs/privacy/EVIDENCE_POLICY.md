# Evidence policy `evidence-policy/1` (Phase 14)

Implementation: `src/privacy/evidence-policy.ts`. Data flows: `docs/privacy/EVIDENCE_DATA_FLOWS.md`.

## Modes

| Mode | Applies to | Persisted evidence |
|---|---|---|
| `minimal` | Default for every target whose `environmentKind` is not `local-fixture` | Identifiers (run, workflow, check, assertion, finding), route templates, roles, counts, verdicts, reason codes, attempt counts, definition hashes and revisions, relative evidence references, explicit omissions. No screenshots or traces. |
| `diagnostic` | Local fixtures; or a profile with `"evidencePolicy": "diagnostic"` | Pre-Phase-14 behaviour, unchanged. The canonical benchmark and challenge corpus use this mode. |

**Never persisted in minimal mode:** control and link names and labels, page titles and visible text, hrefs, query strings and fragments, console and error messages, values typed into or read from controls or query parameters, API response bodies, and model free text about the page.

**Approved configuration** (declared workflow targets, descriptions, suite names, requirement titles) may stay in local files. It is *not* treated as public: exports include it only on explicit request.

## Writing rules

- **Typed field selection before serialization.** Minimizers pick fields by type; they never serialize first and scrub afterwards. `redactSecrets` still runs as a second pass for credentials.
- **No raw fallback.** A minimizer that throws writes `{evidenceGenerationFailed: true, category, reasonCode}` and appends the category to `generationFailures` in `evidence-policy.json`. The execution outcome is recorded separately, so an assertion can pass while its evidence is incomplete.
- **Policy record.** Every new run writes `evidence-policy.json` (policy version, mode, environment kind, omitted categories, generation failures).
- **Legacy.** A run without the policy record is *legacy / privacy-unclassified*. Its files are never rewritten.

## Export

The export is triggered from **5. Results → Export this run**, or through `GET /api/runs/:id/export/preview` and `POST /api/runs/:id/export`.

- **Content:** a projection of allow-listed fields:
  - suite decision and items, comparison, requirement and criterion statuses, check ledger, counts, policy and completeness;
  - observed text only for minimal runs, where the policy has already minimized it.
- **Excluded:**
  - images, traces and archives (`binary-unsupported`);
  - unknown files (`unknown-type`);
  - symbolic links and junctions (never followed).
- **Files:** written under `runs/<id>/exports/<EXP-id>/` (git-ignored) as `export.json` and `export.md`, and downloaded as attachments.
- **Safety:** no network request is made. No absolute paths, usernames or machine names are included.
- **Markdown:** every Markdown and HTML metacharacter is escaped, and control characters are removed, so no link, image or tag can form.
- **Wording:** an export is *"sanitized under evidence-policy/1"*. That is not a guarantee that no personal information remains.

## Compatibility

- **`report.json`** gains `evidencePolicy: {version, mode}`. In minimal mode its `applicationMap` and `findings` hold the minimized shapes. The readers (`qa-report.ts`, `qa-summary.ts` and the UI) handle both shapes.
- **New fields are optional:** `profile.evidencePolicy` and `config.evidencePolicy` are optional, so existing profile fingerprints, check definition hashes and suite revisions are unchanged.
- **Benchmark:** benchmark and grouping consumers read in-memory findings and fixture runs (diagnostic mode), so their inputs are unchanged.
- **Behaviour change for real targets:** screenshots are no longer captured, and response bodies are no longer stored, unless the profile opts into `diagnostic`.

## Limitations

- **Not anonymization.** Minimization is policy-based and was tested with synthetic canaries. Application-chosen route segments that match the generic vocabulary are kept.
- **Run log.** The allow-list keeps logged messages, which are code literals. A future log call that interpolated page text into its message would bypass the field allow-list; URLs inside messages are masked.
- **Live models.** A live explorer or critic still receives page text.
