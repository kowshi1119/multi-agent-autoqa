import { randomBytes } from "node:crypto";
import { realpathSync, existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { resolve, sep } from "node:path";

/** One random token per server process lifetime -- embedded in the served page, echoed back as a header on every mutating request. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export function csrfTokenValid(req: IncomingMessage, expectedToken: string): boolean {
  const provided = req.headers["x-csrf-token"];
  return typeof provided === "string" && provided === expectedToken;
}

/** Loopback-only: validates Origin/Host against the server's own bound address so no other site's page can drive this API cross-origin. */
export function originAllowed(req: IncomingMessage, port: number): boolean {
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const origin = req.headers["origin"];
  if (typeof origin === "string") return allowed.has(origin);
  // No Origin header (e.g. a same-origin navigation, or curl without one) -- fall back to Host, still restricted to loopback.
  const host = req.headers["host"];
  return typeof host === "string" && (host === `127.0.0.1:${port}` || host === `localhost:${port}`);
}

/**
 * Resolves a run-scoped artifact path and rejects anything that escapes
 * `runsRootDir/<runId>` -- via `..`, an absolute path override, or a
 * symlink pointing outside it. Returns undefined (never a path) on any
 * rejection; callers must treat undefined as 404, not as "resolved to
 * root".
 */
export function resolveArtifactPath(runsRootDir: string, runId: string, relativePath: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return undefined;
  const runDir = resolve(runsRootDir, runId);
  const candidate = resolve(runDir, relativePath);
  if (candidate !== runDir && !candidate.startsWith(runDir + sep)) return undefined;
  if (!existsSync(candidate)) return undefined;
  try {
    const real = realpathSync(candidate);
    const realRunDir = realpathSync(runDir);
    if (real !== realRunDir && !real.startsWith(realRunDir + sep)) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}
