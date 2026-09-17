# Phase 5 implementation plan

1. Preserve the dirty working tree and reconcile requirements with current profiles and prior evidence. Reuse the UI launch command in .claude/launch.json; no other skills/hooks/commands exist there.
2. Scope authentication exceptions to login. Add authentication-only runs, readiness checks, sanitized results, cancellation and accounting.
3. Execute optional workflow declarations through the existing planner, FSM, executor, policies and recorder. Assert completion, restrict controls, bound failed candidates and enforce budgets between actions.
4. Snapshot declarations per run; expose outcomes and annotations locally. Validate evidence and refresh derived reports without rewriting original evidence.
5. Add offline regressions, typecheck, build and run the full suite. Separate browser discovery from AutoQA acceptance. Without transient credentials, document live blockers instead of inventing authenticated workflows.

Use explicit mock Explorer and mock Critic. No staging, commits, pushes, PRs, deployment, OrangeHRM work or paid calls.
