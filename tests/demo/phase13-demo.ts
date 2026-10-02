import { resolve } from "node:path";
import { startAuthFixtureServer, type AuthFixtureServer, type FixtureBugs } from "../../fixture/auth-server.js";
import { startServer } from "../../src/server/app.js";
import { saveSuite } from "../../src/suites/suite-manifest.js";
import { preparedTarget } from "../helpers/prepared-target.js";
import { credentials, suiteEnvironment } from "../helpers/suite-env.js";

/**
 * Phase 13 synthetic demonstration through the real local UI server's HTTP
 * API (the same calls the control panel makes). Synthetic fixture and
 * synthetic credentials only; run artifacts go to the repository's local,
 * git-ignored runs/ directory so their IDs can be cited.
 *
 *   npm run build && node dist/tests/demo/phase13-demo.js
 */
async function main(): Promise<void> {
  const runsDir = resolve("runs");
  let fixture: AuthFixtureServer = await startAuthFixtureServer({ statementListApi: "client" });
  const env = suiteEnvironment(fixture.origin, { apiChecks: [], securityChecks: [] });
  env.writeProfile({ apiChecks: { enabled: false, allowedMutatingEndpoints: [], responseSizeCapBytes: 65536, useRunSession: false } });
  saveSuite(env.store, "demo", { id: "wf", name: "Workflow", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }], limits: {} });
  const ui = await startServer({ port: 0, profilesDir: env.profilesDir, runsDir });
  const base = `http://127.0.0.1:${ui.port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": ui.csrfToken }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const rows: string[] = [];
  const run = async (label: string, suiteId: string, bugs: FixtureBugs = {}, onStart?: (runId: string) => void) => {
    fixture.setBugs(bugs);
    const started = await post("/api/runs", { profileId: "demo", mode: "demo", credentials, suiteId, expected: await preparedTarget(base, "demo") });
    const runId = started.body["runId"] as string;
    onStart?.(runId);
    for (;;) {
      const status = await (await fetch(`${base}/api/runs/${runId}/status`)).json() as { active: boolean };
      if (!status.active) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const suite = await (await fetch(`${base}/api/runs/${runId}/suite`)).json() as { result: { decision: string; items: Array<{ identity: string; status: string; reasonCode?: string }> }; comparison: { entries?: Array<{ identity: string; category: string }> } | null; baselineEligibility: { eligible: boolean; reason?: string } };
    const cmp = suite.result.items.find((i) => i.identity.startsWith("consistency-check"));
    const change = suite.comparison?.entries?.find((e) => e.identity.startsWith("consistency-check"))?.category ?? "—";
    rows.push(`| ${label} | \`${runId}\` | ${suite.result.decision} | ${cmp ? `${cmp.status}${cmp.reasonCode && !["ok", "assertion-failed"].includes(cmp.reasonCode) ? ` (${cmp.reasonCode})` : ""}` : "—"} | ${change} | ${suite.baselineEligibility.eligible ? "eligible" : `not eligible: ${suite.baselineEligibility.reason ?? ""}`} |`);
    return runId;
  };

  // A. Signed-in run: the page renders its table from its own GET /api/statement-list, which is observed.
  const runA = await run("A. Observation run (workflow only)", "wf");
  // Later runs: server-rendered rows, so only the approved check reads the API.
  const port = fixture.port;
  await fixture.close();
  fixture = await startAuthFixtureServer({ port, onStatementList: (n) => stopHook?.(n) });
  let stopHook: ((n: number) => Promise<void>) | undefined;

  const observed = await (await fetch(`${base}/api/profiles/demo/runs/${runA}/api-observations`)).json() as { observationSha256: string };
  const selection = { origin: fixture.origin, method: "GET", pathTemplate: "/api/statement-list", query: { page: "1", pageSize: "5" }, assertions: { status: true, contentType: true, shape: ["items", "total"] } };
  const refused = await post("/api/profiles/demo/api-drafts/approve", { runId: runA, selections: [selection], observationSha256: "0".repeat(64), expected: await preparedTarget(base, "demo") });
  const approved = await post("/api/profiles/demo/api-drafts/approve", { runId: runA, selections: [selection], observationSha256: observed.observationSha256, expected: await preparedTarget(base, "demo"), enableApiChecks: true });
  const comparison = { id: "UI-API-STATUS", description: "Statement status on the list page matches the API", workflowId: "OPEN-STATEMENTS", ui: { table: "Statement results", keyColumn: "Merchant", valueColumn: "Status" }, api: { checkId: "OBS-api-statement-list", itemsPath: "items", keyField: "merchant", valueField: "status" }, relation: "status-equal", scope: { pageParam: "page", pageSizeParam: "pageSize", pageSize: 5 }, mode: "separate-check" };
  const moneyRefused = await post("/api/profiles/demo/consistency", { check: { ...comparison, id: "UI-API-AMOUNT", ui: { ...comparison.ui, valueColumn: "Amount" }, api: { ...comparison.api, valueField: "amount" } }, expected: await preparedTarget(base, "demo") });
  const saved = await post("/api/profiles/demo/consistency", { check: comparison, expected: await preparedTarget(base, "demo") });
  saveSuite(env.store, "demo", { id: "ui-api", name: "UI-API", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }, { kind: "consistency-check", id: "UI-API-STATUS", required: true }, { kind: "api-check", id: "OBS-api-statement-list", required: true }], limits: {} });

  const healthy = await run("B. Matching UI and API", "ui-api");
  const baseline = await post(`/api/runs/${healthy}/baseline`, { suiteId: "ui-api" });
  await run("C. API status differs (reproduced)", "ui-api", { apiStatusMismatch: true });
  await run("D. Corrected", "ui-api");
  await run("E. Data changes between observations", "ui-api", { apiStatusFlapping: true });
  await run("F. Missing API field", "ui-api", { apiMissingField: true });
  let stopRunId = "";
  // Calls in this suite: 1 = the API check, 2 = comparison attempt 1, 3 = attempt 2 (Stop lands before it is answered).
  // The fixture's call counter spans runs, so count this run's calls here.
  let callsThisRun = 0;
  stopHook = async () => { callsThisRun++; if (callsThisRun === 3 && stopRunId) await post(`/api/runs/${stopRunId}/stop`, {}); };
  await run("G. Stop during the comparison", "ui-api", { apiStatusMismatch: true }, (id) => { stopRunId = id; });
  stopHook = undefined;
  await run("H. Next run after Stop", "ui-api", { apiStatusMismatch: true });

  console.log(`Draft approval with a stale observation digest: HTTP ${refused.status}; approval: ${JSON.stringify(approved.body)}`);
  console.log(`Money comparison: HTTP ${moneyRefused.status} ${JSON.stringify(moneyRefused.body["problems"])}; comparison saved: ${JSON.stringify(saved.body)}`);
  console.log(`Baseline approved explicitly for ${healthy}: ${JSON.stringify(baseline.body)}`);
  console.log("| Scenario | Run | Suite decision | UI–API comparison | Change vs baseline | Baseline eligibility |\n|---|---|---|---|---|---|");
  console.log(rows.join("\n"));
  ui.server.closeAllConnections(); ui.server.close();
  await fixture.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
