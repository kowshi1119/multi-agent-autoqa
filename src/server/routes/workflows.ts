import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { annotateWorkflow, readSnapshot } from "../../pilot/workflow-runtime.js";
import { loadWorkflowStatus } from "../../pilot/workflow-manifest.js";
import { resolveArtifactPath } from "../security.js";
import { readJsonBody, sendJson } from "../http-helpers.js";

const annotationSchema = z.object({
  workflowId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  status: z.enum(["attempted", "completed", "blocked", "unsupported", "failed"]),
  evidenceRefs: z.array(z.string().min(1)).max(25),
  notes: z.string().max(2000).optional(),
}).strict();

export async function handleWorkflows(req: IncomingMessage, res: ServerResponse, root: string, id: string, active: boolean): Promise<void> {
  const summary = resolveArtifactPath(root, id, "run-summary.json");
  if (!summary) { sendJson(res, 404, { error: "Finished run not found" }); return; }
  const dir = join(root, id);
  try {
    if (req.method === "POST") {
      if (active) { sendJson(res, 409, { error: "Wait for the run to finish before annotating" }); return; }
      const parsed = annotationSchema.safeParse(await readJsonBody(req));
      if (!parsed.success) { sendJson(res, 400, { error: "Invalid workflow annotation" }); return; }
      const data = parsed.data;
      annotateWorkflow(dir, data.workflowId, data.status, data.evidenceRefs, data.notes);
    }
    const authPath = join(dir, "authentication.json");
    sendJson(res, 200, { manifest: readSnapshot(dir) ?? null, status: loadWorkflowStatus(dir), authentication: existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")) : null, budget: JSON.parse(readFileSync(summary, "utf8")).budget });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid workflow annotation" });
  }
}
