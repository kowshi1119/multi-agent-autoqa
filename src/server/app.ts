import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileStore } from "../profiles/store.js";
import { RunManager } from "../run-manager.js";
import { sendJson } from "./http-helpers.js";
import { handleListProfiles } from "./routes/profiles.js";
import { handlePreflight } from "./routes/preflight.js";
import { handleArtifact } from "./routes/artifacts.js";
import { handleListRuns, handleRunEvents, handleRunStatus, handleStartRun, handleStopRun } from "./routes/runs.js";
import { handleSaveTriage } from "./routes/triage.js";
import { csrfTokenValid, generateCsrfToken, originAllowed } from "./security.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ServerHandle = { server: Server; port: number; csrfToken: string };

/**
 * Loopback-only local control panel (Phase 4 Milestone B). No framework:
 * the whole surface is a handful of JSON endpoints plus one static page --
 * Express/Fastify would add a dependency this doesn't need. The run
 * lifecycle itself is entirely owned by RunManager (src/run-manager.ts),
 * which wraps the exact same runPipeline()/assembleReport() functions the
 * CLI uses -- this file is transport only.
 */
export function startServer(options: { port?: number; profilesDir?: string; runsDir?: string } = {}): Promise<ServerHandle> {
  const profileStore = new ProfileStore(options.profilesDir ?? resolve("profiles"));
  const runsRootDir = options.runsDir ?? resolve("runs");
  const runManager = new RunManager(profileStore, runsRootDir);
  const csrfToken = generateCsrfToken();
  const indexHtmlPath = join(__dirname, "public", "index.html");

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");
    const method = req.method ?? "GET";
    const path = url.pathname;

    // Every mutating request is Origin/Host- and CSRF-token-checked before
    // touching any handler. No CORS headers are ever set (no wildcard, no
    // reflected origin) -- this API is never meant to be called cross-origin.
    if (method !== "GET" && method !== "HEAD") {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      if (!originAllowed(req, port) || !csrfTokenValid(req, csrfToken)) {
        sendJson(res, 403, { error: "Origin/Host or CSRF token check failed" });
        return;
      }
    }

    if (path === "/" && method === "GET") {
      const html = readFileSync(indexHtmlPath, "utf-8").replace("__CSRF_TOKEN__", csrfToken);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (path === "/api/profiles" && method === "GET") {
      handleListProfiles(res, profileStore);
      return;
    }

    if (path === "/api/preflight" && method === "GET") {
      const profileId = url.searchParams.get("profileId");
      if (!profileId) {
        sendJson(res, 400, { error: "Missing profileId query parameter" });
        return;
      }
      await handlePreflight(res, profileStore, profileId);
      return;
    }

    if (path === "/api/runs" && method === "POST") {
      await handleStartRun(req, res, runManager);
      return;
    }

    if (path === "/api/runs" && method === "GET") {
      handleListRuns(res, runManager);
      return;
    }

    const stopMatch = /^\/api\/runs\/([^/]+)\/stop$/.exec(path);
    if (stopMatch && method === "POST") {
      handleStopRun(res, runManager, decodeURIComponent(stopMatch[1] as string));
      return;
    }

    const statusMatch = /^\/api\/runs\/([^/]+)\/status$/.exec(path);
    if (statusMatch && method === "GET") {
      handleRunStatus(res, runManager, decodeURIComponent(statusMatch[1] as string));
      return;
    }

    const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(path);
    if (eventsMatch && method === "GET") {
      handleRunEvents(req, res, runManager, decodeURIComponent(eventsMatch[1] as string));
      return;
    }

    const triageMatch = /^\/api\/runs\/([^/]+)\/triage$/.exec(path);
    if (triageMatch && method === "POST") {
      await handleSaveTriage(req, res, runsRootDir, decodeURIComponent(triageMatch[1] as string));
      return;
    }

    const artifactMatch = /^\/api\/artifacts\/([^/]+)\/(.+)$/.exec(path);
    if (artifactMatch && method === "GET") {
      handleArtifact(res, runsRootDir, decodeURIComponent(artifactMatch[1] as string), decodeURIComponent(artifactMatch[2] as string));
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  }

  return new Promise((resolvePromise) => {
    // 127.0.0.1 explicitly -- never 0.0.0.0, never rely on "localhost" resolution alone.
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({ server, port, csrfToken });
    });
  });
}
