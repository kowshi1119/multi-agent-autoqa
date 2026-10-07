import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { startAuthFixtureServer } from "../../fixture/auth-server.js";
import { CANARY_VALUES } from "../../fixture/canaries.js";
import { approveRequirement, saveRequirement } from "../../src/requirements-coverage/requirements.js";
import { startServer } from "../../src/server/app.js";
import { saveSuite } from "../../src/suites/suite-manifest.js";
import { credentials, suiteEnvironment } from "../helpers/suite-env.js";

/**
 * Phase 14 synthetic demonstration through the real control panel (UI
 * clicks, the shared execution path). A real-target-style profile
 * (owned-sandbox, so the minimal evidence policy applies) runs against the
 * synthetic canary fixture. Every result is bound to the run ID of the run
 * just started. Run artifacts go to the git-ignored runs/ directory.
 *
 *   npm run build && node dist/tests/demo/phase14-demo.js
 */
const scratch = resolve(process.env["PHASE14_DEMO_OUT"] ?? join("runs", ".phase14-demo"));

async function startRun(page: Page): Promise<string> {
  await page.waitForFunction(() => !(document.querySelector("#start-btn") as HTMLButtonElement).disabled, undefined, { timeout: 30_000 });
  await page.locator("#auth-username").fill(credentials.username);
  await page.locator("#auth-password").fill(credentials.password);
  const started = page.waitForResponse((r) => r.url().endsWith("/api/runs") && r.request().method() === "POST");
  await page.locator("#start-btn").click();
  return ((await (await started).json()) as { runId: string }).runId;
}

/** Waits for THIS run's results (the coverage panel names the run it shows). */
async function waitForRun(page: Page, runId: string): Promise<void> {
  await page.waitForFunction((id) => document.querySelector("#coverage-report")?.getAttribute("data-run") === id && document.querySelector("#suite-result .suite-decision") !== null, runId, { timeout: 120_000 });
}

const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; }) : [];

async function main(): Promise<void> {
  const runsDir = resolve("runs");
  mkdirSync(scratch, { recursive: true });
  const fixture = await startAuthFixtureServer({ apiAuth: "cookie", canaries: true });
  const env = suiteEnvironment(fixture.origin);
  saveSuite(env.store, "demo", { id: "p", name: "Statements smoke", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }, { kind: "api-check", id: "ME", required: true }], limits: {} });
  saveRequirement(env.store, "demo", { id: "REQ-STATEMENTS", title: "Statements open", description: "", importance: "high", criteria: [{ id: "C1", description: "Statements heading visible", required: true, links: [{ kind: "workflow", itemId: "OPEN-STATEMENTS", assertionId: "visible" }] }] });
  approveRequirement(env.store, "demo", "REQ-STATEMENTS", 1);
  const ui = await startServer({ port: 0, profilesDir: env.profilesDir, runsDir });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ acceptDownloads: true });
  await page.goto(`http://127.0.0.1:${ui.port}`);
  await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
  await page.locator("#profile-select").selectOption("demo");
  await page.waitForFunction(() => /^Target: /.test(document.querySelector("#target-line")?.textContent ?? ""), undefined, { timeout: 30_000 });
  await page.locator("#suite-select").selectOption("p");
  const rows: string[] = [];
  const demoRuns: string[] = [];
  const decision = async () => (await page.locator("#suite-result .suite-decision").getAttribute("data-decision")) ?? "?";

  const scenario = async (label: string, bugs: Record<string, boolean>) => {
    fixture.setBugs(bugs);
    const runId = await startRun(page);
    demoRuns.push(runId);
    await waitForRun(page, runId);
    rows.push(`| ${label} | ${JSON.stringify(bugs)} | \`${runId}\` | ${await decision()} | ${(await page.locator("#coverage-summary").textContent())?.replace(/\s+/g, " ").slice(0, 80) ?? ""} |`);
    return runId;
  };

  const healthy = await scenario("1. Passing workflow on a page with private-looking labels", {});
  await page.locator("#approve-baseline-btn").click();
  await page.waitForFunction(() => /^Approved: run /.test(document.querySelector("#baseline-reason")?.textContent ?? ""));
  const failing = await scenario("2. Seeded defect (heading renamed)", { statementsHeadingChanged: true });
  const newlyFailing = await page.locator("ul[data-list='newly-failing-criteria']").textContent();
  const corrected = await scenario("3. Corrected application", {});

  // Export preview and download for the corrected run.
  await page.locator("#export-preview-btn").click();
  await page.locator(`#export-preview p[data-export-run='${corrected}']`).waitFor();
  await page.screenshot({ path: join(scratch, "export-preview.png"), fullPage: false, clip: await page.locator("#export-panel").boundingBox() ?? undefined });
  await page.locator("#export-create-btn").click();
  const link = page.locator("#export-links a").first();
  await link.waitFor();
  const download = page.waitForEvent("download");
  await link.click();
  const saved = join(scratch, `${corrected}-${(await download).suggestedFilename()}`);
  await (await download).saveAs(saved);

  // Stop, then a usable next run.
  fixture.setBugs({});
  const stoppedId = await startRun(page);
  demoRuns.push(stoppedId);
  await page.locator("#stop-btn").click({ timeout: 10_000 });
  await page.waitForFunction(() => /^Stopped/.test(document.querySelector("#status-line")?.textContent ?? ""), undefined, { timeout: 60_000 });
  rows.push(`| 4. Stop pressed during the run | {} | \`${stoppedId}\` | stopped | — |`);
  const after = await scenario("5. Next run after Stop", {});

  // A diagnostic-profile run (explicit opt-in) captures a screenshot: the export lists it as excluded binary evidence.
  env.writeProfile({ evidencePolicy: "diagnostic" });
  await page.locator("#check-setup-btn").click().catch(() => undefined);
  await page.reload();
  await page.waitForFunction(() => (document.querySelector("#profile-select") as HTMLSelectElement).options.length > 1);
  await page.locator("#profile-select").selectOption("demo");
  await page.waitForFunction(() => /^Target: /.test(document.querySelector("#target-line")?.textContent ?? ""), undefined, { timeout: 30_000 });
  await page.locator("#suite-select").selectOption("p");
  const diagnostic = await scenario("6. Diagnostic profile (explicit opt-in)", {});
  await page.locator("#export-preview-btn").click();
  await page.locator(`#export-preview p[data-export-run='${diagnostic}']`).waitFor();
  const excludedText = (await page.locator("#export-preview").textContent()) ?? "";

  // A legacy run: a synthetic Phase 13.1 demo run recorded before evidence policies existed (no policy record).
  // It is opened from Prior runs and labelled, never rewritten.
  const legacyId = process.env["PHASE14_LEGACY_RUN"] ?? "RUN-20261006-104416718Z-b5cc";
  const legacyBefore = existsSync(join(runsDir, legacyId)) ? files(join(runsDir, legacyId)).filter((f) => !f.includes(`${join(legacyId, "exports")}`)).map((f) => `${f}:${statSync(f).size}`).sort() : [];
  await page.reload();
  await page.locator(".run-row", { hasText: legacyId }).first().click();
  await page.locator("#export-preview-btn").click();
  await page.locator(`#export-preview p[data-export-run='${legacyId}']`).waitFor();
  const legacyLabel = await page.locator(`#export-preview p[data-export-run='${legacyId}']`).getAttribute("data-classification");
  const legacyAfter = files(join(runsDir, legacyId)).filter((f) => !f.includes(`${join(legacyId, "exports")}`)).map((f) => `${f}:${statSync(f).size}`).sort();
  const legacyUnchanged = JSON.stringify(legacyBefore) === JSON.stringify(legacyAfter);

  // Canary sweep over every minimal-policy demo run, its exports and the downloaded file.
  const hits: string[] = [];
  for (const runId of [...demoRuns.filter((id) => id !== diagnostic)]) for (const f of files(join(runsDir, runId))) { const t = readFileSync(f, "latin1"); for (const c of CANARY_VALUES) if (t.includes(c)) hits.push(`${runId}/${f.slice(join(runsDir, runId).length + 1)}: ${c}`); }
  for (const f of [saved, ...files(join(runsDir, diagnostic, "exports"))]) { const t = readFileSync(f, "latin1"); for (const c of CANARY_VALUES) if (t.includes(c)) hits.push(`${f}: ${c}`); }

  console.log("| Scenario | Fixture state | Run | Suite | Requirement coverage |\n|---|---|---|---|---|");
  console.log(rows.join("\n"));
  console.log(`Baseline approved in the UI for ${healthy}; scenario 2 newly failing: ${newlyFailing?.replace(/\s+/g, " ").slice(0, 160)}`);
  console.log(`Export downloaded for ${corrected}: ${saved}`);
  console.log(`Diagnostic run ${diagnostic} export preview lists screenshot exclusion: ${/screenshot\.png[^]*binary-unsupported/.test(excludedText)}`);
  console.log(`Legacy run ${legacyId} labelled: ${legacyLabel}; its files unchanged: ${legacyUnchanged}`);
  console.log(`Canary sweep (minimal runs ${demoRuns.filter((id) => id !== diagnostic).join(", ")}, exports, download): ${hits.length ? hits.join("; ") : "no canary found"}`);
  console.log(`Export preview screenshot: ${join(scratch, "export-preview.png")}`);
  void after; void failing;
  await browser.close();
  ui.server.closeAllConnections(); ui.server.close();
  await fixture.close();
  if (hits.length || legacyLabel !== "legacy" || !legacyUnchanged) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
