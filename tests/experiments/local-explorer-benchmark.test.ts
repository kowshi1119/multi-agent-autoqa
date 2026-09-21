import { describe, expect, it } from "vitest";
import { CASES, runCase } from "../../src/experiments/local-explorer-benchmark.js";
import type { ExplorerProvider } from "../../src/models/provider.js";
import type { ExplorerDecision, ExplorerInput } from "../../src/types.js";

/**
 * Regression test for the confirmed scoring bug (2026-09-21): `runCase()`
 * used to accept "stop" as an acceptableChoice on EVERY case via an
 * unconditional `|| decision.candidateId === "stop"` fallback, so a
 * degenerate provider that always answers "stop" -- doing no real work --
 * scored "acceptable" even on cases where a real candidate was the only
 * correct answer. Proves the fix by running an actual always-stop provider
 * through every real case in CASES, not just asserting internal logic.
 */
class AlwaysStopProvider implements ExplorerProvider {
  readonly name = "always-stop";
  // eslint-disable-next-line @typescript-eslint/require-await
  async decideNextAction(_input: ExplorerInput): Promise<ExplorerDecision> {
    return { candidateId: "stop", testingIntent: "Do nothing", reason: "Always stops, never does real work." };
  }
}

describe("local-explorer-benchmark: acceptableChoice scoring", () => {
  it("does not let a degenerate always-stop provider score acceptable on cases where real work was required", async () => {
    const provider = new AlwaysStopProvider();
    const results = await Promise.all(CASES.map((c) => runCase(provider, c)));

    for (const result of results) {
      const testCase = CASES.find((c) => c.id === result.caseId)!;
      expect(result.validSchema).toBe(true);
      // "stop" is always an offered id, so structural compliance still holds...
      expect(result.offeredCandidateCompliance).toBe(true);
      // ...but acceptableChoice must now reflect whether THIS case actually
      // accepts "stop" as a correct answer, not a blanket pass.
      expect(result.acceptableChoice).toBe(testCase.acceptableCandidateIds.includes("stop"));
    }

    // Sanity: at least one real-work case exists and is correctly scored
    // unacceptable for the always-stop provider (this is the case that a
    // pre-fix run would have wrongly marked "acceptable").
    const realWorkCase = results.find((r) => !CASES.find((c) => c.id === r.caseId)!.acceptableCandidateIds.includes("stop"));
    expect(realWorkCase).toBeDefined();
    expect(realWorkCase!.acceptableChoice).toBe(false);

    // The one genuine "should stop" case is still correctly scored acceptable.
    const stopCase = results.find((r) => CASES.find((c) => c.id === r.caseId)!.acceptableCandidateIds.includes("stop"));
    expect(stopCase).toBeDefined();
    expect(stopCase!.acceptableChoice).toBe(true);
  });
});
