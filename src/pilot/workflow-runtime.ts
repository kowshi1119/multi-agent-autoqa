import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Locator, Page } from "playwright";
import { buildLocator } from "../actions.js";
import type { ElementTarget } from "../types.js";
import { redactSecrets } from "../redact.js";
import { resolveArtifactPath } from "../server/security.js";
import { loadWorkflowStatus, saveWorkflowStatus, summarizeDeclaredWorkflows, workflowManifestSchema, type DeclaredWorkflow, type WorkflowManifest, type WorkflowRunStatus } from "./workflow-manifest.js";

export function snapshotManifest(runDir: string, manifest: WorkflowManifest, secrets: readonly string[] = []): void {
  writeFileSync(join(runDir, "workflow-manifest.json"), redactSecrets(JSON.stringify(manifest, null, 2), secrets));
}
export function readSnapshot(runDir: string): WorkflowManifest | undefined {
  const file = join(runDir, "workflow-manifest.json");
  return existsSync(file) ? workflowManifestSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : undefined;
}

export type AssertionResult = { assertion: string; expected: string; observed: string; passed: boolean };
export type CompletionResult = { passed: boolean; urlMatched: boolean; signalVisible: boolean; assertions: AssertionResult[] };

const describeTarget = (t: ElementTarget): string => [t.role, t.name ?? t.label ?? t.text ?? t.testId].filter(Boolean).join(" ");

function scopedByRole(page: Page, within: ElementTarget | undefined, role: string): Locator {
  // ARIA role strings come from the validated manifest (lowercase words only).
  const root = within ? buildLocator(page, within) : page.locator(":root");
  return root.getByRole(role as Parameters<Page["getByRole"]>[0]);
}

/** Accessible-name-ish text of the result elements, kept in memory only -- evidence records counts and a verdict, never these values. */
export async function resultSnapshot(page: Page, within: ElementTarget | undefined, role: string): Promise<string[]> {
  return scopedByRole(page, within, role).evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") || e.textContent || "").replace(/\s+/g, " ").trim())).catch(() => []);
}

/**
 * Every declared assertion is evaluated and reported with what it expected
 * and what was actually observed. A workflow passes only when all of them
 * hold; a successful click is never enough on its own. Observed values are
 * limited to URL path, the declared query parameters, declared input values
 * and counts -- no page text.
 */
export async function checkCompletion(page: Page, workflow: DeclaredWorkflow, signal?: AbortSignal, snapshot?: string[]): Promise<CompletionResult> {
  const c = workflow.execution?.completion;
  if (!c || signal?.aborted) return { passed: false, urlMatched: false, signalVisible: false, assertions: [] };
  const results: AssertionResult[] = [];
  const urlMatched = await page.waitForURL(new RegExp(c.urlPattern), { timeout: 3000, signal }).then(() => true).catch(() => false) && new RegExp(c.urlPattern).test(page.url());
  const current = new URL(page.url());
  results.push({ assertion: "URL matches the expected page", expected: c.urlPattern, observed: current.pathname, passed: urlMatched });
  const signalVisible = !signal?.aborted && await buildLocator(page, c.visible).waitFor({ state: "visible", timeout: 3000, signal }).then(() => true).catch(() => false);
  results.push({ assertion: "Element visible", expected: describeTarget(c.visible), observed: signalVisible ? "visible" : "not visible", passed: signalVisible });
  for (const [key, value] of Object.entries(c.query ?? {})) {
    const observed = current.searchParams.get(key);
    results.push({ assertion: `Query parameter "${key}"`, expected: value, observed: observed ?? "(absent)", passed: observed === value });
  }
  for (const target of c.absent ?? []) {
    const count = await buildLocator(page, target).count().catch(() => -1);
    results.push({ assertion: "Element absent", expected: `${describeTarget(target)} not present`, observed: count === 0 ? "absent" : count < 0 ? "could not evaluate" : `${count} present`, passed: count === 0 });
  }
  if (c.inputValue) {
    const value = await buildLocator(page, c.inputValue.target).inputValue({ timeout: 3000 }).catch(() => undefined);
    results.push({ assertion: `Control value of ${describeTarget(c.inputValue.target)}`, expected: c.inputValue.equals, observed: value ?? "(control not found)", passed: value === c.inputValue.equals });
  }
  if (c.count) {
    const n = await scopedByRole(page, c.count.within, c.count.role).count().catch(() => -1);
    const range = `${c.count.min ?? 0}..${c.count.max ?? "∞"}`;
    results.push({ assertion: `Number of ${c.count.role} elements`, expected: range, observed: n < 0 ? "could not evaluate" : String(n), passed: n >= (c.count.min ?? 0) && (c.count.max === undefined || n <= c.count.max) });
  }
  if (c.changedFrom) {
    const after = await resultSnapshot(page, c.changedFrom.within, c.changedFrom.role);
    const changed = snapshot !== undefined && (after.length !== snapshot.length || after.some((v, i) => v !== snapshot[i]));
    results.push({ assertion: `${c.changedFrom.role} results differ from the starting page`, expected: `different from the ${snapshot?.length ?? "?"} starting items`, observed: snapshot === undefined ? "no starting snapshot" : `${after.length} items, ${changed ? "different" : "unchanged"}`, passed: changed });
  }
  const passed = !signal?.aborted && results.every((r) => r.passed);
  return { passed, urlMatched, signalVisible, assertions: results };
}

/** Returns to the workflow's declared known state and verifies it. */
export async function resetWorkflow(page: Page, workflow: DeclaredWorkflow, signal?: AbortSignal): Promise<{ attempted: boolean; passed: boolean; detail: string }> {
  if (!workflow.reset) return { attempted: false, passed: true, detail: "No reset declared" };
  try {
    await page.goto(new URL(workflow.reset.pathname, page.url()).href, { waitUntil: "domcontentloaded", timeout: 15_000, signal });
    const pathOk = new URL(page.url()).pathname === workflow.reset.pathname;
    const visible = pathOk && await buildLocator(page, workflow.reset.visible).waitFor({ state: "visible", timeout: 3000, signal }).then(() => true).catch(() => false);
    return { attempted: true, passed: visible, detail: visible ? "Returned to the declared starting state" : pathOk ? "Reset page reached but its declared element was not visible" : `Reset navigation ended on ${new URL(page.url()).pathname}` };
  } catch {
    return { attempted: true, passed: false, detail: signal?.aborted ? "Reset cancelled" : "Reset navigation failed" };
  }
}

/** Immutable runner evidence; annotations are separate and cannot rewrite this file. */
export function recordWorkflow(runDir: string, workflowId: string, status: WorkflowRunStatus, reason: string, evidence: unknown, secrets: readonly string[] = []): void {
  if (!/^[A-Za-z0-9_-]+$/.test(workflowId)) throw new Error("Invalid workflow ID");
  mkdirSync(join(runDir, "workflows"), { recursive: true });
  const ref = `workflows/${workflowId}.json`;
  writeFileSync(join(runDir, ref), redactSecrets(JSON.stringify({ workflowId, status, reason, source: "runner", recordedAt: new Date().toISOString(), evidence }, null, 2), secrets), { flag: "wx" });
  saveWorkflowStatus(runDir, workflowId, status, [ref], undefined, redactSecrets(reason, secrets));
}

export function annotateWorkflow(runDir: string, workflowId: string, status: WorkflowRunStatus, refs: string[], notes?: string): void {
  const manifest = readSnapshot(runDir);
  if (!manifest?.workflows.some(w => w.id === workflowId)) throw new Error("Unknown workflow ID for this run");
  for (const ref of refs) {
    if (!/^(workflows\/|findings\/)/.test(ref) || ref.includes("\\") || ref.split("/").includes("..")) throw new Error("Invalid evidence reference");
    const resolved = resolveArtifactPath(dirname(runDir), basename(runDir), ref);
    if (!resolved || !statSync(resolved).isFile()) throw new Error("Evidence reference must identify an existing file in this run");
  }
  if (status === "completed") {
    const ref = `workflows/${workflowId}.json`;
    if (!refs.includes(ref)) throw new Error("Completed requires the workflow's assertion evidence");
    const original = JSON.parse(readFileSync(join(runDir, ref), "utf8"));
    if (original.status !== "completed" || original.evidence?.assertion?.passed !== true) throw new Error("Runner completion assertion has not passed");
  }
  saveWorkflowStatus(runDir, workflowId, status, refs, undefined, notes);
  refreshPilotSummary(runDir);
}

/** Derived view with explicit source provenance. Never overwrite original reports or evidence. */
export function refreshPilotSummary(runDir: string): void {
  const original = join(runDir, "pilot-summary.json");
  if (!existsSync(original)) return;
  const baseline = JSON.parse(readFileSync(original, "utf8"));
  const triagePath = join(runDir, "triage.json");
  const derived = { ...baseline, derivedAt: new Date().toISOString(), source: "pilot-summary.json", declaredWorkflows: summarizeDeclaredWorkflows(readSnapshot(runDir), loadWorkflowStatus(runDir)), workflowOutcomes: loadWorkflowStatus(runDir).entries, ordinaryTriage: existsSync(triagePath) ? JSON.parse(readFileSync(triagePath, "utf8")) : null };
  writeFileSync(join(runDir, "pilot-summary.latest.json"), redactSecrets(JSON.stringify(derived, null, 2)));
}
