import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { elementTargetSchema, qaActionSchema } from "../actions.js";
import { redactSecrets } from "../redact.js";

/** A human-authored expectation. Optional execution is interpreted by the existing planner/FSM only when the profile selects declared mode. Legacy declarations remain readable. */
export const declaredWorkflowSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  page: z.string().min(1),
  kind: z.enum(["navigate", "search", "filter", "sort", "paginate"]).optional(),
  description: z.string().min(1),
  preconditions: z.string().min(1),
  authorizedActions: z.string().min(1),
  expectedOutcome: z.string().min(1),
  limitations: z.string().optional(),
  evidenceRequired: z.array(z.string()).optional(),
  execution: z.object({
    steps: z.array(z.object({ pathname: z.string().startsWith("/"), resultingPathname: z.string().startsWith("/").optional(), action: qaActionSchema })).min(1).max(25),
    completion: z.object({
      urlPattern: z.string().refine(v => { try { new RegExp(v); return true; } catch { return false; } }, "Invalid URL pattern"),
      visible: elementTargetSchema,
    }),
  }).refine(e => e.steps.every(s => s.action.type !== "stop" && (s.action.type !== "press" || Boolean(s.action.target))), "Workflow steps require supported, explicitly targeted actions").optional(),
});
export type DeclaredWorkflow = z.infer<typeof declaredWorkflowSchema>;

export const workflowManifestSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  pages: z.array(z.string().min(1)),
  workflows: z.array(declaredWorkflowSchema),
}).refine(m => new Set(m.workflows.map(w => w.id)).size === m.workflows.length, "Duplicate workflow IDs");
export type WorkflowManifest = z.infer<typeof workflowManifestSchema>;

export class WorkflowManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowManifestError";
  }
}

function manifestPath(profilesDir: string, profileId: string): string {
  return join(profilesDir, `${profileId}.workflows.json`);
}

/**
 * Absent (undefined) is the honest, expected default -- most profiles
 * (the local fixture included) have no declared-workflow manifest, and
 * that must never be silently treated as "zero workflows attempted" or
 * fabricated as a manifest that doesn't exist. Only a real-application
 * pilot profile is expected to have one.
 */
export function loadWorkflowManifest(profilesDir: string, profileId: string): WorkflowManifest | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(profileId)) throw new WorkflowManifestError("Invalid profile ID");
  const path = manifestPath(profilesDir, profileId);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new WorkflowManifestError(`AutoQA workflow-manifest error\n\nInvalid JSON in ${path}\n${cause}`);
  }
  const result = workflowManifestSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}:\n  ${issue.message}`);
    throw new WorkflowManifestError(`AutoQA workflow-manifest error\n\n${lines.join("\n\n")}`);
  }
  if (result.data.profileId !== profileId) throw new WorkflowManifestError("Manifest profile ID mismatch");
  return result.data;
}

export type WorkflowRunStatus = "attempted" | "completed" | "blocked" | "unsupported" | "failed";

export type WorkflowStatusEntry = {
  workflowId: string;
  status: WorkflowRunStatus;
  evidenceRefs: string[];
  reproductionResult?: string;
  humanReviewStatus: "not-reviewed" | "reviewed";
  notes?: string;
  recordedAt: string;
};

export type WorkflowStatusFile = {
  schemaVersion: 1;
  entries: WorkflowStatusEntry[];
};

const VALID_STATUSES = new Set<WorkflowRunStatus>(["attempted", "completed", "blocked", "unsupported", "failed"]);

function statusPath(runDir: string): string {
  return join(runDir, "workflow-status.json");
}

/**
 * Per-run tracking of each declared workflow's outcome -- mirrors
 * src/human-review/triage.ts's exact runDir-scoped JSON-file pattern (one
 * file per run, one entry per workflow, a re-record replaces the prior
 * entry for that workflow rather than accumulating history). Runner outcomes and later annotations share this status view. Original
 * assertion evidence remains in immutable workflows/<id>.json files.
 */
export function loadWorkflowStatus(runDir: string): WorkflowStatusFile {
  const path = statusPath(runDir);
  if (!existsSync(path)) return { schemaVersion: 1, entries: [] };
  const parsed = z.object({ schemaVersion: z.literal(1), entries: z.array(z.object({
    workflowId: z.string().regex(/^[A-Za-z0-9_-]+$/), status: z.enum(["attempted", "completed", "blocked", "unsupported", "failed"]), evidenceRefs: z.array(z.string()), reproductionResult: z.string().optional(), humanReviewStatus: z.enum(["not-reviewed", "reviewed"]), notes: z.string().optional(), recordedAt: z.string(),
  })) }).safeParse(JSON.parse(readFileSync(path, "utf-8")));
  if (!parsed.success) throw new WorkflowManifestError("Invalid workflow status file");
  return parsed.data;
}

export function saveWorkflowStatus(
  runDir: string,
  workflowId: string,
  status: WorkflowRunStatus,
  evidenceRefs: string[] = [],
  reproductionResult?: string,
  notes?: string
): WorkflowStatusFile {
  if (!/^[A-Za-z0-9_-]+$/.test(workflowId)) throw new WorkflowManifestError("Invalid workflow ID");
  if (!VALID_STATUSES.has(status)) {
    throw new WorkflowManifestError(`WORKFLOW_STATUS_ERROR: invalid status "${status}"`);
  }
  const file = loadWorkflowStatus(runDir);
  const entry: WorkflowStatusEntry = {
    workflowId,
    status,
    evidenceRefs,
    ...(reproductionResult ? { reproductionResult } : {}),
    humanReviewStatus: "not-reviewed",
    ...(notes ? { notes } : {}),
    recordedAt: new Date().toISOString(),
  };
  const withoutPrior = file.entries.filter((e) => e.workflowId !== workflowId);
  const updated: WorkflowStatusFile = { schemaVersion: 1, entries: [...withoutPrior, entry] };
  mkdirSync(runDir, { recursive: true });
  writeFileSync(statusPath(runDir), redactSecrets(JSON.stringify(updated, null, 2)), "utf-8");
  return updated;
}

/** Aggregate counts for PilotSummary -- see src/reporting/pilot-report.ts. */
export type DeclaredWorkflowSummary =
  | { manifestPresent: false }
  | {
      manifestPresent: true;
      declared: number;
      attempted: number;
      completed: number;
      blocked: number;
      unsupported: number;
      failed?: number;
    };

export function summarizeDeclaredWorkflows(manifest: WorkflowManifest | undefined, statusFile: WorkflowStatusFile): DeclaredWorkflowSummary {
  if (!manifest) return { manifestPresent: false };
  const byId = new Map(statusFile.entries.map((e) => [e.workflowId, e]));
  const counts = { attempted: 0, completed: 0, blocked: 0, unsupported: 0, failed: 0 };
  for (const workflow of manifest.workflows) {
    const entry = byId.get(workflow.id);
    if (!entry) continue; // not yet recorded -- neither fabricated as attempted nor counted against the total
    counts[entry.status] += 1;
  }
  return { manifestPresent: true, declared: manifest.workflows.length, ...counts };
}
