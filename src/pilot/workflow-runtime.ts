import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Page } from "playwright";
import { buildLocator } from "../actions.js";
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

export async function checkCompletion(page: Page, workflow: DeclaredWorkflow, signal?: AbortSignal): Promise<{ passed: boolean; urlMatched: boolean; signalVisible: boolean }> {
  const assertion = workflow.execution?.completion;
  if (!assertion || signal?.aborted) return { passed: false, urlMatched: false, signalVisible: false };
  const urlMatched = await page.waitForURL(new RegExp(assertion.urlPattern), { timeout: 3000, signal }).then(() => true).catch(() => false);
  const signalVisible = !signal?.aborted && await buildLocator(page, assertion.visible).waitFor({ state: "visible", timeout: 3000, signal }).then(() => true).catch(() => false);
  return { passed: urlMatched && new RegExp(assertion.urlPattern).test(page.url()) && signalVisible && !signal?.aborted, urlMatched, signalVisible };
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
