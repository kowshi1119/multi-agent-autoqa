import { describe, expect, it } from "vitest";
import { groupFindings } from "../../src/grouping/group-findings.js";
import { matchFindings } from "../../src/reporting/benchmark.js";
import type { Finding } from "../../src/types.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "FINDING-001",
    title: "t",
    status: "validated",
    category: "network",
    pageId: "PAGE-001",
    url: "http://localhost:4173/payment",
    pathname: "/payment",
    expected: "e",
    actual: "a",
    oracle: {
      oracleId: "http-failure",
      suspicious: true,
      expected: "e",
      actual: "a",
      details: { newFailures: [{ method: "POST", url: "http://localhost:4173/api/pay-fail", status: 500 }] },
    },
    steps: [],
    reproduction: { attempts: 3, successes: 3 },
    occurrenceCount: 1,
    evidence: ["oracle.json"],
    evidenceLevel: "L3",
    reportDisposition: "report",
    ...overrides,
  };
}

describe("groupFindings", () => {
  it("groups the same underlying failure reached via two different controls", () => {
    const a = finding({ id: "FINDING-001", controlKey: "spinbutton:Amount" });
    const b = finding({ id: "FINDING-002", controlKey: "button:Submit" });
    const result = groupFindings([a, b], { enabled: true });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.memberFindingIds.sort()).toEqual(["FINDING-001", "FINDING-002"]);
    expect(result.ungrouped).toEqual([]);
  });

  it("keeps two distinct defects sharing page/oracle separate when their endpoints differ", () => {
    const a = finding({ id: "FINDING-001" });
    const b = finding({
      id: "FINDING-002",
      oracle: {
        oracleId: "http-failure",
        suspicious: true,
        expected: "e",
        actual: "a",
        details: { newFailures: [{ method: "POST", url: "http://localhost:4173/api/other-endpoint", status: 500 }] },
      },
    });
    const result = groupFindings([a, b], { enabled: true });

    expect(result.groups).toHaveLength(0);
    expect(result.ungrouped.sort()).toEqual(["FINDING-001", "FINDING-002"]);
    // Same oracle + page, different endpoint -- recorded as a possible relationship, never merged.
    expect(result.possibleRelationships).toHaveLength(1);
    expect(result.possibleRelationships[0]?.findingIds.sort()).toEqual(["FINDING-001", "FINDING-002"]);
  });

  it("never merges a finding with zero persisted evidence", () => {
    const a = finding({ id: "FINDING-001" });
    const b = finding({ id: "FINDING-002", evidence: [] });
    const result = groupFindings([a, b], { enabled: true });

    expect(result.groups).toHaveLength(0);
    expect(result.ungrouped.sort()).toEqual(["FINDING-001", "FINDING-002"]);
  });

  it("surfaces a disposition conflict and picks the reportable member as canonical, never hiding it behind a suppressed one", () => {
    const reportable = finding({ id: "FINDING-001", reportDisposition: "report", reproduction: { attempts: 3, successes: 2 } });
    const suppressed = finding({ id: "FINDING-002", reportDisposition: "suppress", reproduction: { attempts: 3, successes: 3 } });
    const result = groupFindings([suppressed, reportable], { enabled: true });

    expect(result.groups).toHaveLength(1);
    const group = result.groups[0];
    expect(group?.dispositionConflict).toBe(true);
    expect(group?.canonicalFindingId).toBe("FINDING-001");
  });

  it("never fabricates a stronger reproduction rate: memberStats preserves each member's own numbers", () => {
    const a = finding({ id: "FINDING-001", reproduction: { attempts: 3, successes: 2 } });
    const b = finding({ id: "FINDING-002", controlKey: "other-control", reproduction: { attempts: 3, successes: 3 } });
    const result = groupFindings([a, b], { enabled: true });

    const stats = result.groups[0]?.memberStats ?? [];
    expect(stats.find((s) => s.findingId === "FINDING-001")?.reproduction).toEqual({ attempts: 3, successes: 2 });
    expect(stats.find((s) => s.findingId === "FINDING-002")?.reproduction).toEqual({ attempts: 3, successes: 3 });
  });

  it("is idempotent: grouping the constituent findings of an already-grouped result again produces the same group", () => {
    const a = finding({ id: "FINDING-001" });
    const b = finding({ id: "FINDING-002", controlKey: "x" });
    const first = groupFindings([a, b], { enabled: true });
    const second = groupFindings([a, b], { enabled: true });
    expect(second).toEqual(first);
  });

  it("is order-independent: shuffled input produces an identical result", () => {
    const a = finding({ id: "FINDING-001" });
    const b = finding({ id: "FINDING-002", controlKey: "x" });
    const c = finding({ id: "FINDING-003", pathname: "/form", oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a", details: { newErrors: ["x"] } } });

    const forward = groupFindings([a, b, c], { enabled: true });
    const shuffled = groupFindings([c, a, b], { enabled: true });
    expect(shuffled).toEqual(forward);
  });

  it("disabled: every finding stays ungrouped, no groups formed", () => {
    const a = finding({ id: "FINDING-001" });
    const b = finding({ id: "FINDING-002", controlKey: "x" });
    const result = groupFindings([a, b], { enabled: false });

    expect(result.enabled).toBe(false);
    expect(result.groups).toEqual([]);
    expect(result.ungrouped.sort()).toEqual(["FINDING-001", "FINDING-002"]);
  });

  it("all six seeded defects remain individually resolvable by the existing benchmark matcher after grouping (canonical findings only)", () => {
    const groundTruth = [
      { id: "SEED-001", oracleId: "console-error", pathname: "/form" },
      { id: "SEED-002", oracleId: "page-error", pathname: "/account" },
      { id: "SEED-003", oracleId: "http-failure", pathname: "/payment" },
      { id: "SEED-004", oracleId: "duplicate-request", pathname: "/form" },
      { id: "SEED-005", oracleId: "console-error", pathname: "/account" },
      { id: "SEED-006", oracleId: "ui-api-consistency", pathname: "/payment" },
    ];

    // Two manifestations of SEED-003 via different controls -- should group into one.
    const seed003a = finding({ id: "FINDING-003", pathname: "/payment", controlKey: "spinbutton:Amount" });
    const seed003b = finding({ id: "FINDING-005", pathname: "/payment", controlKey: "button:Simulate Payment Error" });
    const others: Finding[] = [
      finding({ id: "FINDING-001", pathname: "/form", oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a", details: { newErrors: ["Seeded QA defect"] } } }),
      finding({ id: "FINDING-002", pathname: "/form", oracle: { oracleId: "duplicate-request", suspicious: true, expected: "e", actual: "a", details: { violations: [{ method: "POST", pathname: "/api/submit", expectedMax: 1, newCount: 2 }] } } }),
      finding({ id: "FINDING-004", pathname: "/account", oracle: { oracleId: "page-error", suspicious: true, expected: "e", actual: "a", details: { newErrors: ["boom"] } } }),
      finding({ id: "FINDING-006", pathname: "/account", oracle: { oracleId: "console-error", suspicious: true, expected: "e", actual: "a", details: { newErrors: ["whitespace defect"] } } }),
      finding({ id: "FINDING-007", pathname: "/payment", oracle: { oracleId: "ui-api-consistency", suspicious: true, expected: "e", actual: "a", details: { ruleId: "payment-consistency", newFailures: [{ method: "POST", url: "http://localhost:4173/api/payment-consistency", status: 500 }] } } }),
    ];

    const all = [seed003a, seed003b, ...others];
    const grouping = groupFindings(all, { enabled: true });
    expect(grouping.groups).toHaveLength(1);

    const canonicalIds = new Set(grouping.groups.map((g) => g.canonicalFindingId));
    const canonicalFindings = all.filter((f) => grouping.ungrouped.includes(f.id) || canonicalIds.has(f.id));
    expect(canonicalFindings).toHaveLength(6);

    const result = matchFindings(canonicalFindings, groundTruth);
    expect(result.truePositives).toHaveLength(6);
    expect(result.falseNegatives).toEqual([]);
  });
});
