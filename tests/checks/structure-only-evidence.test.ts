import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import { saveSuite } from "../../src/suites/suite-manifest.js";
import { runSuite, suiteEnvironment } from "../helpers/suite-env.js";

let server: AuthFixtureServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe("API check evidence and confirmation", () => {
  it("confirms a failing check with the same query, and structure-only evidence never stores the body", async () => {
    server = await startAuthFixtureServer();
    const env = suiteEnvironment(server.origin, {
      apiChecks: [{ id: "LIST-P2", method: "GET", pathname: "/api/statement-list", description: "Second page", query: { page: "2", pageSize: "5" }, evidence: "structure-only", assertions: { expectedStatus: 201, invariants: [] } }],
      securityChecks: [],
    });
    saveSuite(env.store, "demo", { id: "api", name: "API", description: "", items: [{ kind: "api-check", id: "LIST-P2", required: true }], limits: {} });
    const run = await runSuite(env, "api");
    expect(run.result.decision).toBe("FAIL");
    // Regression: the confirmation used to drop the query and request a different resource.
    expect(server.requestLog.filter((r) => r.startsWith("GET /api/statement-list"))).toEqual(["GET /api/statement-list?page=2&pageSize=5", "GET /api/statement-list?page=2&pageSize=5"]);
    const findingDir = join(run.dir, "findings", readdirSync(join(run.dir, "findings"))[0]!);
    for (const file of ["response.json", "confirmation.json"]) {
      const text = readFileSync(join(findingDir, file), "utf-8");
      expect(JSON.parse(text)).toMatchObject({ evidence: "structure-only", bodyRecorded: false, status: 200 });
      for (const value of ["Pharmacy Plus", "Cinema Hall", "st-06", "2026-09-06"]) expect(text).not.toContain(value);
    }
  }, 120_000);
});
