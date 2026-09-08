import type { CriticProvider } from "./critic-provider.js";
import type { ExplorerProvider } from "./provider.js";

export type AgentRole = "explorer" | "critic";

/**
 * Thin composition only — resolves configured model roles, never decides
 * application correctness. `getCritic()` is deliberately nullable (a
 * departure from a stricter non-null signature): `models.critic.enabled:
 * false` is a first-class mode (Experiment Condition A / Phase-1 parity),
 * and returning a non-null value would force either a silently-callable
 * no-op stub (a bug could call it and get a meaningless verdict) or an
 * internal throw inside getCritic() itself — both worse than an explicit
 * null the one call site that needs a critic must check.
 */
export class ModelRouter {
  constructor(
    private readonly explorer: ExplorerProvider,
    private readonly critic: CriticProvider | null
  ) {}

  getExplorer(): ExplorerProvider {
    return this.explorer;
  }

  getCritic(): CriticProvider | null {
    return this.critic;
  }

  hasCritic(): boolean {
    return this.critic !== null;
  }
}
