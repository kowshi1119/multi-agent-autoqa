import type { ServerResponse } from "node:http";
import { loadCheckLedger } from "../../checks/evidence.js";
import { resolveArtifactPath } from "../security.js";
import { sendJson } from "../http-helpers.js";

/** GET-only: check-results.json is written only by the run itself (see run-manager.ts's integration point), never annotated by the client. */
export function handleChecks(res: ServerResponse, root: string, runId: string): void {
  const dir = resolveArtifactPath(root, runId, ".");
  if (!dir) {
    sendJson(res, 404, { error: "Run not found" });
    return;
  }
  sendJson(res, 200, loadCheckLedger(dir));
}
