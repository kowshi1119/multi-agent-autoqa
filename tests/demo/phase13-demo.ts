import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AUTH_FIXTURE_ACCOUNTS, startAuthFixtureServer, type AuthFixtureServer, type FixtureBugs } from "../../fixture/auth-server.js";
import { startServer } from "../../src/server/app.js";
import { saveSuite } from "../../src/suites/suite-manifest.js";
import { preparedTarget } from "../helpers/prepared-target.js";
import { credentials, suiteEnvironment } from "../helpers/suite-env.js";

/**
 * Phase 13.1 synthetic acceptance demonstration through the real local UI
 * server's HTTP API (the calls the control panel makes) and the shared
 * execution path. Synthetic fixture and synthetic credentials only; run
 * artifacts go to the repository's git-ignored runs/ directory so their
 * IDs can be cited. Fixture state is set explicitly before every scenario.
 *
 *   npm run build && node dist/tests/demo/phase13-demo.js
 */
type SuiteView = { result: { decision: string; items: Array<{ identity: string; status: string; reasonCode?: string }> }; comparison: { entries?: Array<{ identity: string; category: string }> } | null; baselineEligibility: { eligible: boolean; reason?: string } };

async function main(): Promise<void> {
  const runsDir = resolve("runs");
  let fixture: AuthFixtureServer = await startAuthFixtureServer({ statementListApi: "client", compressApi: true });
  const env = suiteEnvironment(fixture.origin, { apiChecks: [], securityChecks: [] });
  env.writeProfile({ apiChecks: { enabled: false, allowedMutatingEndpoints: [], responseSizeCapBytes: 65536, useRunSession: false } });
  saveSuite(env.store, "demo", { id: "wf", name: "Workflow", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }], limits: {} });
  const ui = await startServer({ port: 0, profilesDir: env.profilesDir, runsDir });
  const base = `http://127.0.0.1:${ui.port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": ui.csrfToken }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const target = () => preparedTarget(base, "demo");
  const rows: string[] = [];
  const demoRuns: string[] = [];
  let onCall: (() => Promise<void>) | undefined;

  /** Starts a suite run and waits for THIS run's own result (bound to its run ID). */
  const run = async (label: string, suiteId: string, bugs: FixtureBugs, onStart?: (runId: string) => void): Promise<string> => {
    fixture.setBugs(bugs);
    const started = await post("/api/runs", { profileId: "demo", mode: "demo", credentials, suiteId, expected: await target() });
    const runId = started.body["runId"] as string;
    if (!runId) throw new Error(`${label}: run not started: ${JSON.stringify(started.body)}`);
    demoRuns.push(runId);
    onStart?.(runId);
    for (;;) {
      const status = await (await fetch(`${base}/api/runs/${runId}/status`)).json() as { active: boolean };
      if (!status.active) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const suite = await (await fetch(`${base}/api/runs/${runId}/suite`)).json() as SuiteView;
    const usage = JSON.parse(readFileSync(join(runsDir, runId, "check-usage.json"), "utf-8")) as { requests: number };
    const cmp = suite.result.items.find((i) => i.identity.startsWith("consistency-check"));
    const change = suite.comparison?.entries?.find((e) => e.identity.startsWith("consistency-check"))?.category ?? "—";
    rows.push(`| ${label} | ${JSON.stringify(bugs)} | \`${runId}\` | ${suite.result.decision} | ${cmp ? `${cmp.status}${cmp.reasonCode && !["ok", "assertion-failed"].includes(cmp.reasonCode) ? ` (${cmp.reasonCode})` : ""}` : "—"} | ${change} | ${usage.requests} |`);
    return runId;
  };

  // 1. Observation: the page renders from its own compressed GET /api/statement-list.
  const observed = await run("1. Observation run (workflow only)", "wf", {});
  const observation = await (await fetch(`${base}/api/profiles/demo/runs/${observed}/api-observations`)).json() as { observationSha256: string; observation: { endpoints: Array<{ pathTemplate: string; samplesWithBody: number; omissions: Array<{ reason: string }> }> } };
  const list = observation.observation.endpoints.find((e) => e.pathTemplate === "/api/statement-list")!;

  // 2. Stage A: status + content type only (no shape is known), approved explicitly.
  const selection = { origin: fixture.origin, method: "GET", pathTemplate: "/api/statement-list", query: { page: "1", pageSize: "5" }, assertions: { status: true, contentType: true } };
  const staleRefused = await post("/api/profiles/demo/api-drafts/approve", { runId: observed, selections: [selection], observationSha256: "0".repeat(64), expected: await target() });
  const stageA = await post("/api/profiles/demo/api-drafts/approve", { runId: observed, selections: [selection], observationSha256: observation.observationSha256, expected: await target(), enableApiChecks: true });

  // Later runs: server-rendered rows (only AutoQA's approved check reads the API), still compressed.
  const port = fixture.port;
  await fixture.close();
  fixture = await startAuthFixtureServer({ port, compressApi: true, onStatementList: async () => { await onCall?.(); } });

  // 3. The approved check executes through the bounded requester.
  saveSuite(env.store, "demo", { id: "api", name: "API", description: "", items: [{ kind: "api-check", id: "OBS-api-statement-list", required: true }], limits: {} });
  const executed = await run("3. Approved check executed", "api", {});

  // 4. Stage B: proposals from its evidence, without any request to the application.
  const requestsBefore = fixture.requestLog.length;
  const drafts = await post("/api/profiles/demo/check-evidence-drafts", { runId: executed, checkId: "OBS-api-statement-list" });
  const draftBody = drafts.body["drafts"] as { proposals: Array<{ field: string; expected: string }>; source: { evidenceSha256: string } };
  const requestsDuringDrafting = fixture.requestLog.length - requestsBefore;
  const stageB = await post("/api/profiles/demo/check-evidence-drafts/approve", { runId: executed, checkId: "OBS-api-statement-list", evidenceSha256: draftBody.source.evidenceSha256, fields: ["items", "total"], expected: await target() });
  const suites = await (await fetch(`${base}/api/profiles/demo/suites`)).json() as { suites: Array<{ id: string; valid: boolean; errors: string[] }> };
  const staleSuite = suites.suites.find((s) => s.id === "api")!;
  saveSuite(env.store, "demo", { id: "api", name: "API", description: "", items: [{ kind: "api-check", id: "OBS-api-statement-list", required: true }], limits: {} });

  // 5. Comparison (money refused; status saved) and the UI–API suite.
  const comparison = { id: "UI-API-STATUS", description: "Statement status on the list page matches the API", workflowId: "OPEN-STATEMENTS", ui: { table: "Statement results", keyColumn: "Merchant", valueColumn: "Status" }, api: { checkId: "OBS-api-statement-list", itemsPath: "items", keyField: "merchant", valueField: "status" }, relation: "status-equal", scope: { pageParam: "page", pageSizeParam: "pageSize", pageSize: 5 }, mode: "separate-check" };
  const moneyRefused = await post("/api/profiles/demo/consistency", { check: { ...comparison, id: "UI-API-AMOUNT", ui: { ...comparison.ui, valueColumn: "Amount" }, api: { ...comparison.api, valueField: "amount" } }, expected: await target() });
  const saved = await post("/api/profiles/demo/consistency", { check: comparison, expected: await target() });
  saveSuite(env.store, "demo", { id: "ui-api", name: "UI-API", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }, { kind: "consistency-check", id: "UI-API-STATUS", required: true }, { kind: "api-check", id: "OBS-api-statement-list", required: true }], limits: {} });

  const healthy = await run("6. Matching UI and API", "ui-api", {});
  const baseline = await post(`/api/runs/${healthy}/baseline`, { suiteId: "ui-api" });
  await run("7. Seeded API status mismatch", "ui-api", { apiStatusMismatch: true });
  await run("8. Corrected application", "ui-api", {});
  // Calls in this suite: 1 = the API check, 2 = comparison attempt 1 (flipped), 3 = attempt 2 (not flipped).
  await run("9. Data changes between observations", "ui-api", { apiStatusFlapping: { flipOn: "even" } });
  // Calls in this suite: 1 = the API check, 2 = comparison attempt 1, 3 = attempt 2 (Stop lands before it is answered).
  let stopRunId = "";
  let calls = 0;
  onCall = async () => { calls++; if (calls === 3 && stopRunId) await post(`/api/runs/${stopRunId}/stop`, {}); };
  await run("10. Stop during the comparison (mismatch seeded)", "ui-api", { apiStatusMismatch: true }, (id) => { stopRunId = id; });
  onCall = undefined;
  await run("11. Next run after Stop (fixture reset to healthy)", "ui-api", {});

  // Canary sweep: the synthetic password anywhere; record values in reports, logs, drafts and comparison artifacts.
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
  // report.json/report.md and application-map.json are excluded from the record-value sweep: the Phase 1
  // application map records visible control and link names of visited pages by design (a known limitation,
  // tracked separately). Everything Phase 13 writes is swept.
  const sensitiveFiles = /(check-results|suite-result|suite-comparison|coverage-report|qa-summary|run\.log|api-observations|response|confirmation|consistency|request|check-usage)\b/;
  const canaryHits: string[] = [];
  for (const runId of demoRuns) {
    for (const file of files(join(runsDir, runId))) {
      if (/\.(png|jpe?g|webm|zip)$/.test(file)) continue;
      const text = readFileSync(file, "utf-8");
      if (text.includes(AUTH_FIXTURE_ACCOUNTS["demo-a"].password)) canaryHits.push(`${file}: password`);
      if (sensitiveFiles.test(file)) for (const value of ["Book Nook", "Coffee House", "Grocery Mart"]) if (text.includes(value)) canaryHits.push(`${file}: ${value}`);
    }
  }
  const draftsText = JSON.stringify(drafts.body);
  for (const value of ["Book Nook", "Coffee House", "pending", "st-01"]) if (draftsText.includes(value)) canaryHits.push(`stage-B drafts: ${value}`);

  console.log(`Observation of compressed GET /api/statement-list: ${list.samplesWithBody} body samples; omissions ${JSON.stringify(list.omissions.map((o) => o.reason))}`);
  console.log(`Stage A: stale-digest approval HTTP ${staleRefused.status}; approval ${JSON.stringify(stageA.body)}`);
  console.log(`Stage B: proposals ${JSON.stringify(draftBody.proposals.map((p) => `${p.field}:${p.expected}`))}; requests to the application while drafting: ${requestsDuringDrafting}; approval ${JSON.stringify(stageB.body)}`);
  console.log(`Suite "api" after stage-B approval: valid=${staleSuite.valid} (${staleSuite.errors.join(" ")}); re-saved explicitly as revision 2`);
  console.log(`Money comparison: HTTP ${moneyRefused.status}; status comparison saved: ${JSON.stringify(saved.body)}`);
  console.log(`Baseline approved explicitly for ${healthy}: ${JSON.stringify(baseline.body)}`);
  console.log(`Canary sweep over ${demoRuns.length} runs: ${canaryHits.length ? canaryHits.join("; ") : "no synthetic password and no compared record values found"}`);
  console.log("| Scenario | Fixture state | Run | Suite | UI–API comparison | vs baseline | HTTP check requests |\n|---|---|---|---|---|---|---|");
  console.log(rows.join("\n"));
  ui.server.closeAllConnections(); ui.server.close();
  await fixture.close();
  if (canaryHits.length || requestsDuringDrafting !== 0 || !existsSync(join(runsDir, executed))) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
