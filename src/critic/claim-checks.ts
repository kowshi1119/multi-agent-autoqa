import type { CriticDecision, CriticInput } from "../types.js";

export type ClaimCheckResult = { claim: string; status: "supported" | "contradicted" | "uncheckable"; detail: string };

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

function extractClaimedRequestCount(text: string): number | null {
  const match = /\bonly\s+(one|two|three|four|five|\d+)\s+requests?\b/i.exec(text);
  if (!match?.[1]) return null;
  const token = match[1].toLowerCase();
  return NUMBER_WORDS[token] ?? Number(token);
}

/**
 * Bounded, structured, code-verifiable claim checks -- replaces reliance
 * on the old contradiction-check.ts's narrow "only N requests" prose-
 * pattern regex (still used here for the one thing it can express, but
 * now checked against the correct, disclosed denominator instead of raw
 * text parsing). Checks only what the schema/response can express in
 * structured form: evidenceReferences pointing at real evidence file
 * names, requirementConflict referencing an id actually present in the
 * scoped requirement context this call received, and a stated network-
 * request count compared against evidence.networkScope.matchedForTrigger-
 * ingEndpoint (never total page traffic, per the same scope-disclosure
 * A2 introduced). Explicitly NOT a general NLP fact-checker -- an
 * "uncheckable" claim never independently forces report or suppress; only
 * "contradicted" feeds criticEvidenceConflict, via decideDisposition's
 * existing contradiction outcome.
 */
export function checkClaims(decision: CriticDecision, input: CriticInput): ClaimCheckResult[] {
  const results: ClaimCheckResult[] = [];

  const knownEvidenceFiles = new Set<string>([
    "oracle.json",
    "reproduction.json",
    "console.json",
    "network.json",
    "page-errors.json",
    "visible-text.json",
    ...(input.evidence.screenshotPaths.length > 0 ? ["screenshot.png"] : []),
    ...(input.evidence.traceAvailable ? ["trace.zip"] : []),
  ]);
  for (const ref of decision.evidenceReferences) {
    results.push(
      knownEvidenceFiles.has(ref)
        ? { claim: `evidenceReferences:${ref}`, status: "supported", detail: "references a real evidence file for this finding" }
        : { claim: `evidenceReferences:${ref}`, status: "uncheckable", detail: "not a recognized evidence file name for this finding" }
    );
  }

  if (decision.requirementConflict) {
    const known = (input.requirementContext ?? []).some((r) => r.id === decision.requirementConflict);
    results.push({
      claim: `requirementConflict:${decision.requirementConflict}`,
      status: known ? "supported" : "contradicted",
      detail: known
        ? "matches a requirement actually scoped to this finding"
        : "does not match any requirement scoped to this finding -- the critic may have invented or misremembered an id",
    });
  }

  const claimedCount = extractClaimedRequestCount(`${decision.summary} ${decision.alternativeExplanation ?? ""}`);
  if (claimedCount !== null) {
    const actual = input.evidence.networkScope.matchedForTriggeringEndpoint;
    results.push({
      claim: `claimedRequestCount:${claimedCount}`,
      status: claimedCount === actual ? "supported" : "contradicted",
      detail: `critic stated ${claimedCount} request(s); evidence shows ${actual} matching the triggering endpoint (of ${input.evidence.networkScope.totalPageRequests} total page requests captured)`,
    });
  }

  return results;
}

/** The first contradicted claim, if any -- what feeds CRITIC_EVIDENCE_CONTRADICTION. Uncheckable claims never trigger this. */
export function firstContradiction(results: ClaimCheckResult[]): ClaimCheckResult | undefined {
  return results.find((r) => r.status === "contradicted");
}
