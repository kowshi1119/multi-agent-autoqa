import type { ServerResponse } from "node:http";
import { loadCheckLedger } from "../../checks/evidence.js";
import { resolveArtifactPath } from "../security.js";
import { sendJson } from "../http-helpers.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** GET-only: check-results.json is written only by the run itself (see run-manager.ts's integration point), never annotated by the client. */
export function handleChecks(res: ServerResponse, root: string, runId: string): void {
  const dir = resolveArtifactPath(root, runId, ".");
  if (!dir) {
    sendJson(res, 404, { error: "Run not found" });
    return;
  }
  const usagePath = join(dir, "check-usage.json");
  const usage: unknown = existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, "utf8")) : null;
  sendJson(res, 200, { ...loadCheckLedger(dir), usage });
}
