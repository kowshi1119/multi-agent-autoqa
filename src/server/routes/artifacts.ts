import { createReadStream, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename, extname } from "node:path";
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
  // Exports are downloaded, never rendered in the panel's origin.
  const download = /^exports\/EXP-[A-Za-z0-9-]+\/export\.(json|md)$/.test(relativePath.replace(/\\/g, "/"));
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "X-Content-Type-Options": "nosniff",
    ...(download ? { "Content-Disposition": `attachment; filename="${basename(resolved)}"`, "Cache-Control": "no-store" } : {}),
  });
  createReadStream(resolved).pipe(res);
}
