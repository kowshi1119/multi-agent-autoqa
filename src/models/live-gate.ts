export class LiveModeNotAuthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveModeNotAuthorizedError";
  }
}

/**
 * Requires an explicit --live CLI flag (mirrors provider-check.ts's
 * existing --live precedent) whenever this run's configured explorer or
 * critic provider is not "mock" -- including explorer:"auto", which may
 * itself resolve to a real provider whenever a credential happens to be
 * present. An API key already sitting in .env is deliberately NOT treated
 * as authorization by itself: only a deliberate --live flag on THIS
 * invocation authorizes a real, billed provider request. Never silently
 * downgrades a live-configured run to mock, and never silently proceeds
 * live without --live -- both would violate "no provider request without
 * deliberate live selection."
 *
 * Called from every entry point that can make a live call and does NOT
 * already have its own equivalent gate: the `qa`/`benchmark` CLIs (via
 * run-pipeline.ts's opt-in `requireLiveAuthorization`), Phase 3
 * experiment capture/replay, and standalone experiment replay. RunManager
 * (the local UI's run path) deliberately does NOT call this -- it already
 * has its own, stricter mode/confirmedLimits-based live gate (see
 * run-manager.ts#startRun), and a CLI --live flag has no meaning inside a
 * long-running server process.
 */
export type LiveGateModelsConfig = {
  models: {
    explorer: { provider: string };
    critic: { enabled: boolean; provider: string };
  };
};

export function assertLiveModeAuthorized(config: LiveGateModelsConfig, argv: readonly string[] = process.argv): void {
  if (argv.includes("--live")) return;

  const explorerLive = config.models.explorer.provider !== "mock";
  const criticLive = config.models.critic.enabled && config.models.critic.provider !== "mock";
  if (!explorerLive && !criticLive) return;

  const offending = [
    explorerLive ? `explorer=${config.models.explorer.provider}` : null,
    criticLive ? `critic=${config.models.critic.provider}` : null,
  ]
    .filter((v): v is string => Boolean(v))
    .join(", ");

  throw new LiveModeNotAuthorizedError(
    `LIVE_MODE_NOT_AUTHORIZED: this run would make a real provider request (${offending}) but --live was not passed on the command line. ` +
      'An API key present in .env is not authorization by itself -- pass --live to explicitly authorize real, billed provider requests for this run, or set the provider(s) to "mock".'
  );
}
