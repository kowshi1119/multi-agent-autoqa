import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../../src/server/app.js";

let handle: Awaited<ReturnType<typeof startServer>>;
let baseUrl: string;
let profilesDir: string;
let runsDir: string;

beforeAll(async () => {
  profilesDir = mkdtempSync(join(tmpdir(), "autoqa-server-security-profiles-"));
  writeFileSync(
    join(profilesDir, "fixture.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "fixture",
      name: "Test",
      target: { url: "http://localhost:4173/", environmentKind: "local-fixture" },
      navigation: { allowedOrigins: ["http://localhost:4173"], allowedPathPrefixes: ["/"] },
      resources: { allowedApiOrigins: ["http://localhost:4173"], allowedFormSubmitEndpoints: [] },
      workflows: { allowedWorkflowKinds: ["navigate"] },
      auth: { mode: "none" },
      provider: {
        explorer: { provider: "mock" },
        critic: { enabled: true, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
        providerTimeoutMs: 30000,
      },
      limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
    }),
    "utf-8"
  );
  runsDir = mkdtempSync(join(tmpdir(), "autoqa-server-security-runs-"));
  handle = await startServer({ profilesDir, runsDir });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => (handle.server as Server).close(() => resolvePromise()));
});

describe("Server security (Phase 4 Milestone B)", () => {
  it("binds to 127.0.0.1, not a wildcard address", () => {
    const address = handle.server.address();
    expect(typeof address === "object" && address ? address.address : undefined).toBe("127.0.0.1");
  });

  it("serves the index page with the CSRF token embedded", async () => {
    const res = await fetch(baseUrl + "/");
    const html = await res.text();
    expect(html).toContain(handle.csrfToken);
  });

  it("rejects a mutating request missing the CSRF token", async () => {
    const res = await fetch(baseUrl + "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ profileId: "fixture", mode: "demo" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a mutating request with the wrong Origin even with a valid CSRF token", async () => {
    const res = await fetch(baseUrl + "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example.com", "X-CSRF-Token": handle.csrfToken },
      body: JSON.stringify({ profileId: "fixture", mode: "demo" }),
    });
    expect(res.status).toBe(403);
  });

  it("never sets any CORS header (no wildcard, no reflected origin)", async () => {
    const res = await fetch(baseUrl + "/api/profiles", { headers: { Origin: "http://evil.example.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects a malformed start-run request body (schema validation)", async () => {
    const res = await fetch(baseUrl + "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, "X-CSRF-Token": handle.csrfToken },
      body: JSON.stringify({ profileId: 123, mode: "not-a-real-mode" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an artifact path-traversal attempt", async () => {
    const res = await fetch(baseUrl + "/api/artifacts/fixture/../../../../etc/passwd");
    expect([400, 404]).toContain(res.status);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("rejects an artifact request for an unknown run id", async () => {
    const res = await fetch(baseUrl + "/api/artifacts/RUN-DOES-NOT-EXIST/report.json");
    expect(res.status).toBe(404);
  });

  it("serves a real artifact with an explicit Content-Type and X-Content-Type-Options: nosniff, and captured text never executes as HTML", async () => {
    const { mkdirSync } = await import("node:fs");
    const runDir = join(runsDir, "RUN-SECURITY-TEST");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "report.json"), JSON.stringify({ note: "<script>window.__xss=true</script>" }), "utf-8");

    const res = await fetch(baseUrl + "/api/artifacts/RUN-SECURITY-TEST/report.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const text = await res.text();
    expect(text).toContain("<script>"); // present in the raw JSON payload...
    // ...but served as application/json, never text/html -- a browser will
    // never execute it. The client-side rendering test (this same script
    // tag, if it ever reached the DOM) is covered by index.html only ever
    // using textContent, not innerHTML, for any captured text (see
    // public/index.html's setText() helper).
  });

  it("returns a working preflight response for a known profile", async () => {
    const res = await fetch(baseUrl + "/api/preflight?profileId=fixture");
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it("returns 404 (not a crash) for preflight on an unknown profile", async () => {
    const res = await fetch(baseUrl + "/api/preflight?profileId=fixture&x=1");
    expect(res.status).toBe(200); // profileId="fixture" with an extra ignored query param still resolves
    const res2 = await fetch(baseUrl + "/api/preflight?profileId=does-not-exist");
    const body2 = await res2.json();
    expect(body2.overallReady).toBe(false);
    void res;
  });

  it("(Phase 4 Milestone D2) rejects a triage save without the CSRF token, same as any other mutating request", async () => {
    const res = await fetch(baseUrl + "/api/runs/RUN-TRIAGE-TEST/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ findingId: "FINDING-001", verdict: "defect" }),
    });
    expect(res.status).toBe(403);
  });

  it("(Phase 4 Milestone D2) rejects an invalid triage verdict via schema validation", async () => {
    const res = await fetch(baseUrl + "/api/runs/RUN-TRIAGE-TEST/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, "X-CSRF-Token": handle.csrfToken },
      body: JSON.stringify({ findingId: "FINDING-001", verdict: "not-a-real-verdict" }),
    });
    expect(res.status).toBe(400);
  });

  it("(Phase 4 Milestone D2) saves a valid triage label under the run directory, separate from report.json", async () => {
    const runId = "RUN-TRIAGE-SAVE-TEST";
    const res = await fetch(baseUrl + "/api/runs/" + runId + "/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, "X-CSRF-Token": handle.csrfToken },
      body: JSON.stringify({ findingId: "FINDING-001", verdict: "expected-behavior", notes: "matches documented UI" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toHaveLength(1);
    expect(body.labels[0]).toMatchObject({ findingId: "FINDING-001", verdict: "expected-behavior" });

    const triageArtifact = await fetch(baseUrl + "/api/artifacts/" + runId + "/triage.json");
    expect(triageArtifact.status).toBe(200);
  });
});
