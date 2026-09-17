import { refreshPilotSummary } from "../../pilot/workflow-runtime.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { z } from "zod";
import { saveTriageLabel, TriageError } from "../../human-review/triage.js";
import { readJsonBody, sendJson } from "../http-helpers.js";

const triageRequestSchema = z.object({
  findingId: z.string().min(1),
  verdict: z.enum(["defect", "expected-behavior", "unsure"]),
  notes: z.string().max(2000).optional(),
});

/** Ordinary (non-blind) manual triage -- runsRootDir/<runId>/triage.json, never mutating report.json/finding.json. */
export async function handleSaveTriage(req: IncomingMessage, res: ServerResponse, runsRootDir: string, runId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
    sendJson(res, 400, { error: "Invalid run id" });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" });
    return;
  }
  const parsed = triageRequestSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: "Invalid triage request", issues: parsed.error.issues });
    return;
  }
  try {
    const runDir = resolve(runsRootDir, runId);
    const result = saveTriageLabel(runDir, parsed.data.findingId, parsed.data.verdict, parsed.data.notes);
    refreshPilotSummary(runDir);
    sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof TriageError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}
