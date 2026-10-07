import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { buildExportData, ExportError, renderExportMarkdown, writeExport } from "../../reporting/export.js";
import { readJsonBody, sendJson } from "../http-helpers.js";

/**
 * Local export of one run (src/reporting/export.ts). Reading the preview
 * and writing the export only read local files; nothing is sent to the
 * tested application or anywhere else.
 */
function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof ExportError) { sendJson(res, error.code === "not-found" ? 404 : 422, { error: error.message, code: error.code }); return; }
  throw error;
}

export function handleExportPreview(res: ServerResponse, runsRoot: string, runId: string, includeApprovedLabels: boolean): void {
  try {
    const exported = buildExportData(runsRoot, runId, { includeApprovedLabels });
    sendJson(res, 200, { manifest: exported.manifest, markdownPreview: renderExportMarkdown(exported) });
  } catch (error) { fail(res, error); }
}

const exportSchema = z.object({ includeApprovedLabels: z.boolean().default(false) }).strict();

export async function handleExport(req: IncomingMessage, res: ServerResponse, runsRoot: string, runId: string, activeRunId: string | undefined): Promise<void> {
  let body: unknown;
  try { body = await readJsonBody(req); } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request body" }); return; }
  const parsed = exportSchema.safeParse(body ?? {});
  if (!parsed.success) { sendJson(res, 400, { error: "Invalid export request." }); return; }
  if (activeRunId === runId) { sendJson(res, 409, { error: "The run is still in progress; export it after it finishes." }); return; }
  try {
    const written = writeExport(runsRoot, runId, parsed.data);
    sendJson(res, 200, { exportId: written.exportId, files: written.files, manifest: written.manifest });
  } catch (error) { fail(res, error); }
}
