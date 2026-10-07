import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { CANARY_VALUES, INERT_PAYLOADS } from "../../fixture/canaries.js";
import { __failMinimizerForTest, readPolicyFile } from "../../src/privacy/evidence-policy.js";
import { buildExportData, escapeMarkdown, ExportError, renderExportMarkdown, writeExport } from "../../src/reporting/export.js";
import { approveRequirement, saveRequirement } from "../../src/requirements-coverage/requirements.js";
import type { RunProgressEvent } from "../../src/progress.js";
import { approveBaseline } from "../../src/suites/baselines.js";
import { findSuite, saveSuite, suiteContentHash } from "../../src/suites/suite-manifest.js";
import { runSuite, suiteEnvironment } from "../helpers/suite-env.js";

let server: AuthFixtureServer | undefined;
afterEach(async () => { __failMinimizerForTest(undefined); await server?.close(); server = undefined; });

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}
/** Every canary found in any text file under `dir` (binary formats are not produced in minimal mode). */
function canaryHits(dir: string): string[] {
  return filesUnder(dir).flatMap((file) => {
    const text = readFileSync(file, "latin1");
    return CANARY_VALUES.filter((c) => text.includes(c)).map((c) => `${file.slice(dir.length)}: ${c}`);
  });
}

async function setup(extra: { canaries?: boolean | "inert"; bugs?: Record<string, boolean> } = {}) {
  server = await startAuthFixtureServer({ apiAuth: "cookie", canaries: extra.canaries ?? true, ...(extra.bugs ? { bugs: extra.bugs } : {}) });
  const env = suiteEnvironment(server.origin); // owned-sandbox profile: the minimal evidence policy applies by default
  saveSuite(env.store, "demo", { id: "p", name: "Privacy", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }, { kind: "api-check", id: "ME", required: true }], limits: {} });
  return env;
}

describe("evidence privacy for real-target runs (synthetic canary fixture)", () => {
  it("keeps every canary out of artifacts, logs, events, temporary output and exports, while the workflow and checks still run", async () => {
    const tmpBefore = new Set(readdirSync(tmpdir()));
    const env = await setup();
    const events: RunProgressEvent[] = [];
    const run = await runSuite(env, "p", {}, (runId) => { env.manager.subscribe(runId, (e) => events.push(e)); });
    expect(run.result.decision).toBe("PASS");
    expect(run.result.items.find((i) => i.itemId === "OPEN-STATEMENTS")).toMatchObject({ status: "passed" });
    expect(readPolicyFile(run.dir)).toMatchObject({ policyVersion: "evidence-policy/1", mode: "minimal", generationFailures: [] });
    // The application map keeps structure: pages, roles and counts, with run-local references.
    const map = JSON.parse(readFileSync(join(run.dir, "application-map.json"), "utf-8")) as { pages: Array<{ pageRef: string; pathTemplate: string; counts: { controls: number; links: number }; controls: Array<{ ref: string; role: string | null }> }> };
    const home = map.pages.find((p) => p.pathTemplate === "/home")!;
    expect(home.counts.links).toBeGreaterThan(3);
    expect(new Set(home.controls.map((c) => c.ref)).size).toBe(home.controls.length); // distinct controls keep distinct references
    expect(canaryHits(run.dir)).toEqual([]);
    expect(CANARY_VALUES.filter((c) => JSON.stringify(events).includes(c))).toEqual([]);
    // Export: zero requests to the application, nothing private in preview or files.
    const before = server!.requestLog.length;
    const preview = buildExportData(env.runsDir, run.runId);
    const written = writeExport(env.runsDir, run.runId, { includeApprovedLabels: true });
    expect(server!.requestLog.length).toBe(before);
    expect(CANARY_VALUES.filter((c) => JSON.stringify(preview).includes(c) || renderExportMarkdown(preview).includes(c))).toEqual([]);
    expect(canaryHits(join(run.dir, "exports"))).toEqual([]);
    expect(written.manifest).toMatchObject({ sanitizedUnder: "evidence-policy/1", source: { classification: "minimal" }, evidenceCompleteness: { complete: true } });
    expect(written.manifest.included.map((c) => c.artifact)).toEqual(expect.arrayContaining(["suite-result.json", "check-results.json"]));
    expect(written.manifest.omitted.map((c) => c.artifact)).toEqual(expect.arrayContaining(["application-map.json", "run.log", "report.json"]));
    // Temporary output created by this test (the run's own temp directory included).
    const newTmp = readdirSync(tmpdir()).filter((n) => !tmpBefore.has(n)).map((n) => join(tmpdir(), n));
    expect(newTmp.flatMap((p) => statSync(p).isDirectory() ? canaryHits(p) : [])).toEqual([]);
  }, 180_000);

  it("still detects a seeded defect with explanatory minimized evidence, passes the correction, and compares by stable identity", async () => {
    const env = await setup({ bugs: { statementsHeadingChanged: true } });
    saveRequirement(env.store, "demo", { id: "REQ-STATEMENTS", title: "Statements open", description: "", importance: "high", criteria: [{ id: "C1", description: "Statements heading visible", required: true, links: [{ kind: "workflow", itemId: "OPEN-STATEMENTS", assertionId: "visible" }] }] });
    approveRequirement(env.store, "demo", "REQ-STATEMENTS", 1);
    const failing = await runSuite(env, "p");
    expect(failing.result.decision).toBe("FAIL");
    const record = JSON.parse(readFileSync(join(failing.dir, "workflows", "OPEN-STATEMENTS.json"), "utf-8")) as { evidence: { assertion: { assertions: Array<{ id: string; expected: string; observed: string; passed: boolean }> }; reproduced: boolean } };
    expect(record.evidence.assertion.assertions.find((a) => a.id === "visible")).toMatchObject({ expected: "heading Statements", observed: "not visible", passed: false });
    expect(record.evidence.reproduced).toBe(true);
    const coverage = JSON.parse(readFileSync(join(failing.dir, "requirement-coverage.json"), "utf-8")) as { coverage: { requirements: Array<{ requirementId: string; status: string }> } };
    expect(coverage.coverage.requirements[0]).toMatchObject({ requirementId: "REQ-STATEMENTS", status: "failed" });
    // The export carries the same requirement verdict (projection of the coverage file).
    expect(buildExportData(env.runsDir, failing.runId).data.requirements).toEqual([expect.objectContaining({ requirementId: "REQ-STATEMENTS", status: "failed" })]);
    expect(canaryHits(failing.dir)).toEqual([]);

    server!.setBugs({});
    const corrected = await runSuite(env, "p");
    expect(corrected.result.decision).toBe("PASS");
    const suite = findSuite(env.profilesDir, "demo", "p");
    approveBaseline(env.profilesDir, env.runsDir, "demo", suite, suiteContentHash(suite), corrected.runId);
    server!.setBugs({ statementsHeadingChanged: true });
    const regressed = await runSuite(env, "p");
    expect(regressed.comparison?.entries.find((e) => e.identity === "workflow:OPEN-STATEMENTS#visible")?.category).toBe("newly-failing");
    expect(canaryHits(regressed.dir)).toEqual([]);
  }, 300_000);

  it("Stop leaves no unsafe or late writes, and a sanitizer failure writes a marker instead of raw evidence", async () => {
    const env = await setup();
    const stopped = await runSuite(env, "p", {}, (runId) => { setTimeout(() => env.manager.stopRun(runId), 1_500); });
    const filesAtEnd = filesUnder(stopped.dir).sort();
    await new Promise((r) => setTimeout(r, 2_000));
    expect(filesUnder(stopped.dir).sort()).toEqual(filesAtEnd); // nothing written after the run finished
    expect(canaryHits(stopped.dir)).toEqual([]);

    __failMinimizerForTest("workflow");
    const failed = await runSuite(env, "p");
    const record = JSON.parse(readFileSync(join(failed.dir, "workflows", "OPEN-STATEMENTS.json"), "utf-8")) as { status: string; evidence: unknown };
    expect(record.status).toBe("completed"); // the execution outcome is unchanged...
    expect(record.evidence).toMatchObject({ evidenceGenerationFailed: true, category: "workflow" }); // ...the evidence says it could not be produced
    expect(readPolicyFile(failed.dir)!.generationFailures.map((f) => f.category)).toContain("workflow");
    expect(buildExportData(env.runsDir, failed.runId).manifest.evidenceCompleteness.complete).toBe(false);
    expect(canaryHits(failed.dir)).toEqual([]);
  }, 240_000);

  it("keeps diagnostic mode unchanged when a profile opts in, and still exports only structured fields", async () => {
    const env = await setup();
    env.writeProfile({ evidencePolicy: "diagnostic" });
    const run = await runSuite(env, "p");
    expect(readPolicyFile(run.dir)).toMatchObject({ mode: "diagnostic" });
    expect(readFileSync(join(run.dir, "application-map.json"), "utf-8")).toContain("CanaryLinkTw45"); // diagnostic keeps page text locally, as before
    const exported = writeExport(env.runsDir, run.runId);
    expect(exported.manifest.source.classification).toBe("diagnostic");
    expect(canaryHits(join(run.dir, "exports"))).toEqual([]);
  }, 180_000);

  it("labels a legacy run privacy-unclassified, exports no observed text from it, and leaves its files untouched", async () => {
    const env = await setup();
    const run = await runSuite(env, "p");
    const legacyId = `${run.runId.slice(0, -4)}0ld0`;
    const legacyDir = join(env.runsDir, legacyId);
    cpSync(run.dir, legacyDir, { recursive: true });
    rmSync(join(legacyDir, "evidence-policy.json"));
    writeFileSync(join(legacyDir, "workflows", "OPEN-STATEMENTS.json"), readFileSync(join(legacyDir, "workflows", "OPEN-STATEMENTS.json"), "utf-8").replace('"observed": "visible"', '"observed": "legacy observed CanaryNestedWe5e"'));
    const suiteResultPath = join(legacyDir, "suite-result.json");
    writeFileSync(suiteResultPath, readFileSync(suiteResultPath, "utf-8").replace('"observed": "visible"', '"observed": "legacy observed CanaryNestedWe5e"'));
    const originalBytes = readFileSync(suiteResultPath, "utf-8");
    const exported = writeExport(env.runsDir, legacyId);
    expect(exported.manifest.source).toMatchObject({ classification: "legacy", runPolicy: null });
    expect(canaryHits(join(legacyDir, "exports"))).toEqual([]);
    expect(readFileSync(suiteResultPath, "utf-8")).toBe(originalBytes);
  }, 180_000);
});

describe("export safety (no application needed)", () => {
  const fakeRun = () => {
    const runsDir = mkdtempSync(join(tmpdir(), "autoqa-export-"));
    const runId = "RUN-20261007-000000000Z-abcd";
    const dir = join(runsDir, runId);
    mkdirSync(join(dir, "findings", "FINDING-001"), { recursive: true });
    writeFileSync(join(dir, "run-summary.json"), JSON.stringify({ runId, status: "completed", stopReason: "INTERNAL_ERROR: <img src=x>" }));
    writeFileSync(join(dir, "notes.txt"), "unknown artifact");
    writeFileSync(join(dir, "findings", "FINDING-001", "screenshot.png"), "png");
    return { runsDir, runId, dir };
  };

  it("refuses invalid or traversing run IDs and never follows links out of the run", () => {
    const { runsDir, runId, dir } = fakeRun();
    expect(() => buildExportData(runsDir, "RUN-../../x")).toThrow(ExportError);
    expect(() => buildExportData(runsDir, "../RUN-20261007-000000000Z-abcd")).toThrow(ExportError);
    const outside = mkdtempSync(join(tmpdir(), "autoqa-outside-"));
    writeFileSync(join(outside, "secret.json"), JSON.stringify({ leaked: "CanaryJsonVal7c" }));
    symlinkSync(outside, join(dir, "linked"), "junction");
    const exported = buildExportData(runsDir, runId);
    expect(exported.manifest.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifact: "linked", reason: expect.stringContaining("symbolic link") }),
      expect.objectContaining({ artifact: "notes.txt", reason: expect.stringContaining("unknown-type") }),
      expect.objectContaining({ artifact: "findings/FINDING-001/screenshot.png", reason: expect.stringContaining("binary-unsupported") }),
    ]));
    expect(JSON.stringify(exported)).not.toContain("CanaryJsonVal7c");
    expect(exported.manifest.source.classification).toBe("legacy");
    expect(JSON.stringify(exported)).not.toContain(runsDir); // no absolute paths
  });

  it("renders untrusted text inertly in Markdown", () => {
    for (const payload of INERT_PAYLOADS) {
      const out = escapeMarkdown(payload);
      // Every Markdown/HTML metacharacter is backslash-escaped, so no tag, link or image can form.
      expect(out).not.toMatch(/(?<!\\)[<>[\]()!`]/);
      expect(out).not.toMatch(/[\u0000-\u001f]/);
    }
    const { runsDir, runId } = fakeRun();
    const md = renderExportMarkdown(buildExportData(runsDir, runId));
    expect(md).not.toContain("<img");
    expect(md).toContain("sanitized under evidence");
  });
});
