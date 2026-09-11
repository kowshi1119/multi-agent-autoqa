import { createReadStream, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname } from "node:path";
import { resolveArtifactPath } from "../security.js";
import { sendJson } from "../http-helpers.js";

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".zip": "application/zip",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

/**
 * Resolves strictly through registered run directories (see
 * resolveArtifactPath) -- rejects traversal/symlink escapes, never
 * accepts a raw filesystem path from the client. Every response carries
 * an explicit, allowlisted Content-Type plus X-Content-Type-Options:
 * nosniff -- an evidence file is never served in a way a browser could
 * interpret as HTML.
 */
export function handleArtifact(res: ServerResponse, runsRootDir: string, runId: string, relativePath: string): void {
  const resolved = resolveArtifactPath(runsRootDir, runId, relativePath);
  if (!resolved) {
    sendJson(res, 404, { error: "Artifact not found" });
    return;
  }
  const stat = statSync(resolved);
  if (!stat.isFile()) {
    sendJson(res, 404, { error: "Artifact not found" });
    return;
  }

  const contentType = CONTENT_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(resolved).pipe(res);
}
