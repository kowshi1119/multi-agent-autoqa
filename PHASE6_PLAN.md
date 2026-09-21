# Phase 6 plan — authenticated Ajeer acceptance

Date: 2026-09-18. Reuse the Phase 5 runner and preserve all existing work. No staging, commits, push, PR or deployment.

1. Verify current profile, manifest, local UI, execution path and sanitized run history. Confirm mock Explorer and mock Critic before every Ajeer run.
2. Obtain a user-controlled authenticated observation: final URL and exact visible heading or landmark. Replace only observed profile checks; enter credentials only through the transient local UI. Never recover chat credentials or persist browser state.
3. Prove authentication through AutoQA, then observe and declare 3–5 safe read-only workflows with exact scoped actions, deterministic assertions, source of expectations, evidence and reset requirements.
4. Run sequentially: auth-only smoke, one workflow, remaining workflows, fresh repetition of a completed workflow. Preserve the existing limits and authentication exceptions. Record real run IDs and outcomes.
5. Correct only demonstrated generic compatibility failures, with regression coverage. Verify types, build and offline regressions. Update the existing pilot/setup/Phase 5 documents and a Phase 6 acceptance record. Keep optional Gemini validation separate and unexecuted.

Initial gap: profile checksVerified=false; generic placeholder signal; no executable Ajeer workflows. UI responds at http://127.0.0.1:4180/. Browser inspection currently fails with a Windows sandbox initialization error. Awaiting non-secret authenticated observation; do not bypass readiness or manufacture declarations while waiting.
