import type { CriticProvider } from "../models/critic-provider.js";
import type { CriticDecision, CriticInput, RequirementContext } from "../types.js";

function requirementMatches(req: RequirementContext, input: CriticInput): boolean {
  if (req.pathname !== input.environment.pathname) return false;

  if (req.triggerRequestPathname) {
    const triggered = input.evidence.network.some(
      (n) => n.pathname === req.triggerRequestPathname && typeof n.status === "number" && n.status >= 500
    );
    if (!triggered) return false;
  }

  if (req.expectedVisibleText) {
    if (!input.evidence.uiTextExcerpt?.includes(req.expectedVisibleText)) return false;
  }

  return true;
}

/**
 * Deterministic, architecture-proving critic. Never reads finding.id
 * (CriticInput has no such field), never reads ground truth (structurally
 * absent from CriticInput). The requirement match is a generic behavioral
 * comparison (does the observed network/UI evidence match what a scoped
 * requirement says should happen), not an ID lookup table -- it works for
 * any future requirement of this shape, not just the fixture's specific
 * ones. Use only to prove the architecture; this does NOT establish LLM
 * critic quality.
 */
export class MockCriticProvider implements CriticProvider {
  name = "mock";

  // eslint-disable-next-line @typescript-eslint/require-await
  async critique(input: CriticInput): Promise<CriticDecision> {
    if (input.evidenceLevel === "L6") {
      return {
        verdict: "needs_human",
        confidence: 0.4,
        summary: "AI-suspicion-only evidence (L6) always requires human review.",
        evidenceReferences: [],
        missingEvidence: ["deterministic oracle or requirement support"],
      };
    }

    const match = input.requirementContext?.find((req) => requirementMatches(req, input));
    if (match) {
      return {
        verdict: "invalid",
        confidence: 0.85,
        summary: `Observed behavior matches documented requirement ${match.id}.`,
        evidenceReferences: ["oracle.json", "network.json"],
        alternativeExplanation: `Matches expected-failure/known-limitation requirement ${match.id}: ${match.description}`,
        missingEvidence: [],
        requirementConflict: match.id,
      };
    }

    const strong = input.reproduction.attempts > 0 && input.reproduction.successes >= input.reproduction.attempts * (2 / 3);

    if ((input.evidenceLevel === "L1" || input.evidenceLevel === "L2") && strong) {
      return {
        verdict: "valid",
        confidence: 0.9,
        summary: "Deterministic reproducible evidence, no matching requirement found.",
        evidenceReferences: ["oracle.json", "reproduction.json"],
        missingEvidence: [],
      };
    }

    if (input.evidenceLevel === "L3" && strong) {
      return {
        verdict: "valid",
        confidence: 0.7,
        summary: "Reproducible runtime/network anomaly, no requirement or environmental explanation found.",
        evidenceReferences: ["oracle.json", "reproduction.json"],
        missingEvidence: [],
      };
    }

    return {
      verdict: "needs_human",
      confidence: 0.3,
      summary: "Evidence insufficient for a confident automated verdict.",
      evidenceReferences: [],
      missingEvidence: ["stronger reproduction or requirement support"],
    };
  }
}
