import type { CriticDecision, CriticInput } from "../types.js";

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

function extractClaimedRequestCount(text: string): number | null {
  const match = /\bonly\s+(one|two|three|four|five|\d+)\s+requests?\b/i.exec(text);
  if (!match?.[1]) return null;
  const token = match[1].toLowerCase();
  return NUMBER_WORDS[token] ?? Number(token);
}

/**
 * Best-effort text-pattern check, not a general fact-checker. Catches the
 * spec's own literal example (critic says "only one request occurred"
 * when the evidence shows more) via a crafted pattern; it will not
 * generalize to arbitrary creative phrasing a live LLM critic might use.
 * Documented as best-effort in README -- a fuller NLP fact-checker would
 * itself be over-engineering for what this is meant to catch.
 */
export function detectEvidenceContradiction(decision: CriticDecision, input: CriticInput): string | null {
  const text = `${decision.summary} ${decision.alternativeExplanation ?? ""}`;
  const claimedCount = extractClaimedRequestCount(text);
  if (claimedCount !== null && claimedCount !== input.evidence.network.length) {
    return `CRITIC_EVIDENCE_CONTRADICTION: critic claimed ${claimedCount} request(s) but evidence shows ${input.evidence.network.length}.`;
  }
  return null;
}
