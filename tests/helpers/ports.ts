/**
 * §Port isolation fix (2026-09-16): this registry previously documented six
 * hardcoded literal ports, each hand-picked to dodge EADDRINUSE collisions
 * between concurrently-running test files. The reason they existed --
 * `runPipeline()`'s local-fixture auto-start deriving the fixture server's
 * port from `config.target.url` BEFORE that server existed, so the port had
 * to be decided up front -- no longer holds.
 *
 * `runPipeline()` (src/run-pipeline.ts) now ALWAYS binds a local-fixture
 * target's server to port 0 (OS-assigned), regardless of whatever literal
 * port `config.target.url` declares, and substitutes the real bound origin
 * back into `config.target.url`/`config.safety.allowedOrigins` in place
 * before anything downstream reads it. A literal port in a local-fixture
 * config or profile (e.g. `qa.config.mock.yaml`'s own `4173`, or any of the
 * five test-authored ports this table used to list) is now inert
 * placeholder text -- never actually bound, never a collision risk,
 * regardless of how many such configs run concurrently. Confirmed via a
 * dedicated regression test (see "runPipeline() local-fixture port
 * isolation" in tests/run-pipeline-port-isolation.test.ts) that runs two
 * concurrent local-fixture pipelines declaring the SAME placeholder port
 * and asserts both succeed on two distinct real ports.
 *
 * This file is kept (rather than deleted) so a future reader who finds a
 * literal fixture-shaped port in a config understands why it's safe to
 * leave as-is, and doesn't reintroduce a hand-picked-port convention this
 * fix was written to retire. Nothing imports this file at runtime.
 */
export const RESERVED_FIXTURE_PORTS: readonly number[] = [];
