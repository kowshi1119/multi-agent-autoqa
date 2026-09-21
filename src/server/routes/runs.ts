import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ProfileError } from "../../profiles/schema.js";
import { LiveModeNotConfirmedError, NoWorkflowsConfiguredError, PreflightFailedError, RunAlreadyActiveError, type RunManager } from "../../run-manager.js";
import { readJsonBody, sendJson } from "../http-helpers.js";

const limitsSchema = z.object({
  maxActions: z.number().int().positive(),
  maxModelCalls: z.number().int().positive(),
  maxPages: z.number().int().positive(),
  maxFindings: z.number().int().positive(),
  maxDurationMs: z.number().int().positive(),
  maxCriticCalls: z.number().int().positive(),
});

const startRunSchema = z.object({
  profileId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  mode: z.enum(["demo", "live"]),
  credentials: z.object({ username: z.string().min(1), password: z.string().min(1) }).optional(),
  confirmedLimits: limitsSchema.optional(),
  authenticationOnly: z.boolean().optional(),
  workflowIds: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).min(1).optional(),
});

export async function handleStartRun(req: IncomingMessage, res: ServerResponse, runManager: RunManager): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" });
    return;
  }

  const parsed = startRunSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: "Invalid start-run request", issues: parsed.error.issues });
    return;
  }

  try {
    const { runId } = await runManager.startRun(parsed.data);
    sendJson(res, 200, { runId });
  } catch (error) {
    if (error instanceof RunAlreadyActiveError) {
      sendJson(res, 409, { error: error.message });
      return;
    }
    if (error instanceof LiveModeNotConfirmedError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    if (error instanceof PreflightFailedError) {
      sendJson(res, 400, { error: error.message, failedChecks: error.failedChecks });
      return;
    }
    if (error instanceof NoWorkflowsConfiguredError) {
      sendJson(res, 400, { error: error.message, code: "NO_WORKFLOWS_CONFIGURED" });
      return;
    }
    if (error instanceof ProfileError) {
      sendJson(res, 404, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

export function handleStopRun(res: ServerResponse, runManager: RunManager, runId: string): void {
  const stopped = runManager.stopRun(runId);
  sendJson(res, 200, { stopped });
}

export function handleRunStatus(res: ServerResponse, runManager: RunManager, runId: string): void {
  const active = runManager.getActiveRun();
  if (active?.runId === runId) {
    sendJson(res, 200, { active: true, ...active });
    return;
  }
  const list = runManager.listRuns();
  const found = list.find((r) => r.runId === runId);
  if (!found) {
    sendJson(res, 404, { error: "Unknown run id" });
    return;
  }
  sendJson(res, 200, { active: false, ...found });
}

export function handleListRuns(res: ServerResponse, runManager: RunManager): void {
  sendJson(res, 200, { runs: runManager.listRuns(), activeRun: runManager.getActiveRun() ?? null });
}

/** text/event-stream -- structured events only, never console-text-scraping. Reconnect-after-drop uses handleRunStatus() (polling) instead of historical replay. */
export function handleRunEvents(req: IncomingMessage, res: ServerResponse, runManager: RunManager, runId: string): void {
  const active = runManager.getActiveRun();
  if (active?.runId !== runId) {
    sendJson(res, 404, { error: "Run is not active (already finished, or never existed) -- use /api/runs/:id/status instead" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const unsubscribe = runManager.subscribe(runId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on("close", unsubscribe);
}
