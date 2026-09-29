import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { startServer } from "../../src/server/app.js";
import { suiteEnvironment } from "../helpers/suite-env.js";
import { preparedTarget } from "../helpers/prepared-target.js";

let server: AuthFixtureServer | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await server?.close(); server = undefined;
  for (const c of closers.splice(0)) await c();
});

const document = readFileSync("fixture/contracts/accounts.openapi.json", "utf-8");

async function setup() {
  server = await startAuthFixtureServer();
  const env = suiteEnvironment(server.origin);
  const ui = await startServer({ port: 0, profilesDir: env.profilesDir, runsDir: env.runsDir });
  closers.push(() => new Promise((r) => { ui.server.closeAllConnections(); ui.server.close(() => r()); }));
  const base = `http://127.0.0.1:${ui.port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": ui.csrfToken }, body: JSON.stringify(body) });
  return { env, base, post };
}

describe("contract and requirement routes", () => {
  it("parses and drafts without contacting anything, approves only in-scope GET drafts, and saves nothing on refusal", async () => {
    const { env, base, post } = await setup();
    const before = readFileSync(join(env.profilesDir, "demo.checks.json"), "utf-8");
    const parsed = await (await post("/api/profiles/demo/contract/parse", { document })).json() as { operations: Array<{ key: string; readOnly: boolean }> };
    expect(parsed.operations.map((o) => o.key)).toContain("POST /api/transfer");
    expect((await post("/api/profiles/demo/contract/parse", { document: JSON.stringify({ openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {} }) })).status).toBe(422);
    const drafts = await (await post("/api/profiles/demo/contract/drafts", { document, source: "accounts.openapi.json", selections: [{ operation: "GET /api/accounts/{accountId}", pathParams: { accountId: "acc-1" } }] })).json() as { drafts: Array<{ executable: boolean }> };
    expect(drafts.drafts[0]!.executable).toBe(true);
    const hits = [...server!.hits.values()].reduce((a, b) => a + b, 0);
    expect(hits).toBe(0);

    const expected = await preparedTarget(base, "demo");
    const refusedPost = await post("/api/profiles/demo/contract/approve", { document, source: "accounts.openapi.json", selections: [{ operation: "POST /api/transfer" }], expected });
    expect(refusedPost.status).toBe(422);
    const refusedScope = await post("/api/profiles/demo/contract/approve", { document, source: "accounts.openapi.json", selections: [{ operation: "GET /api/accounts/{accountId}", pathParams: { accountId: ".." } }], expected });
    expect(refusedScope.status).toBe(422);
    expect(readFileSync(join(env.profilesDir, "demo.checks.json"), "utf-8")).toBe(before);
    const stale = await post("/api/profiles/demo/contract/approve", { document, source: "accounts.openapi.json", selections: [{ operation: "GET /api/accounts/{accountId}", pathParams: { accountId: "acc-1" } }], expected: { ...expected, fingerprint: "0".repeat(64) } });
    expect(stale.status).toBe(409);
    const ok = await post("/api/profiles/demo/contract/approve", { document, source: "accounts.openapi.json", selections: [{ operation: "GET /api/accounts/{accountId}", pathParams: { accountId: "acc-1" } }], expected });
    expect(await ok.json()).toEqual({ saved: ["CONTRACT-GETACCOUNT"] });
    const saved = JSON.parse(readFileSync(join(env.profilesDir, "demo.checks.json"), "utf-8")) as { apiChecks: Array<{ id: string; pathname: string; method: string }> };
    expect(saved.apiChecks.find((c) => c.id === "CONTRACT-GETACCOUNT")).toMatchObject({ method: "GET", pathname: "/api/accounts/acc-1" });
    expect(JSON.stringify(saved)).not.toContain("untrusted.example");
  });

  it("edits, approves, exports and imports requirements as drafts", async () => {
    const { base, post } = await setup();
    const requirement = { id: "REQ-1", title: "Statements open", description: "", importance: "high", criteria: [{ id: "C1", description: "Statements page opens", required: true, links: [{ kind: "workflow", itemId: "OPEN-STATEMENTS", assertionId: "visible" }] }] };
    const saved = await post("/api/profiles/demo/requirements", { requirement });
    expect((await saved.json() as { requirement: { status: string } }).requirement.status).toBe("draft");
    expect((await post("/api/profiles/demo/requirements/REQ-1/approve", { revision: 1 })).status).toBe(200);
    const bad = await post("/api/profiles/demo/requirements", { requirement: { ...requirement, id: "REQ-2", criteria: [{ id: "C1", description: "x", required: true, links: [{ kind: "workflow", itemId: "NOPE", assertionId: "url" }] }] } });
    expect(bad.status).toBe(400);
    const listed = await (await fetch(`${base}/api/profiles/demo/requirements`)).json() as { requirements: Array<{ status: string }>; catalog: unknown[] };
    expect(listed.requirements.map((r) => r.status)).toEqual(["approved"]);
    const exported = await fetch(`${base}/api/profiles/demo/requirements/export`);
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const body = await exported.json();
    const imported = await (await post("/api/profiles/demo/requirements/import", body)).json() as { imported: Array<{ status: string; revision: number }> };
    expect(imported.imported).toEqual([{ id: "REQ-1", revision: 2, status: "draft" }]);
    const suggestions = await (await fetch(`${base}/api/profiles/demo/requirements/suggestions`)).json() as { suggestions: unknown[]; note: string };
    expect(suggestions.note).toContain("not saved or approved");
  });
});
