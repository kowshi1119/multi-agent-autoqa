import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_FIXTURE_ACCOUNTS, startAuthFixtureServer, type AuthFixtureServer } from "../../fixture/auth-server.js";
import type { ApiObservations } from "../../src/auth/api-observer.js";
import { saveSuite } from "../../src/suites/suite-manifest.js";
import { runSuite, suiteEnvironment } from "../helpers/suite-env.js";

let server: AuthFixtureServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("API observer in an authenticated run", () => {
  it("records the application's own API traffic after sign-in, without values, secrets or extra requests", async () => {
    server = await startAuthFixtureServer({ apiAuth: "cookie" });
    const env = suiteEnvironment(server.origin);
    saveSuite(env.store, "demo", { id: "wf", name: "Workflow only", description: "", items: [{ kind: "workflow", id: "OPEN-STATEMENTS", required: true }], limits: {} });
    const run = await runSuite(env, "wf");
    const text = readFileSync(join(run.dir, "api-observations.json"), "utf-8");
    const observations = JSON.parse(text) as ApiObservations;
    expect(observations.label).toContain("Not an official API contract");
    expect(observations.drain).toBe("drained");
    const me = observations.endpoints.find((e) => e.pathTemplate === "/api/me")!;
    expect(me).toMatchObject({ origin: server.origin, method: "GET", statuses: [200], contentTypes: ["application/json"], seenOnPages: ["/home"], ambiguous: false });
    expect(me.shape["$.email"]).toEqual({ types: ["string"], seenIn: me.samplesWithBody });
    // The sign-in exchange is never observed (observation starts after sign-in succeeds).
    expect(observations.endpoints.some((e) => e.pathTemplate === "/session")).toBe(false);
    // One /api/me call per load of /home, made by the page itself: nothing extra from the observer.
    expect(server.hits.get("GET /api/me") ?? 0).toBeLessThanOrEqual(server.hits.get("GET /home") ?? 0);
    expect(me.observations).toBeLessThanOrEqual(server.hits.get("GET /api/me") ?? 0);
    // Canary sweep over every artifact of the run: no password, email, account id or session cookie value.
    const account = AUTH_FIXTURE_ACCOUNTS["demo-a"];
    const secrets = [account.password, account.email, ...server.issuedSessionIds];
    for (const file of filesUnder(run.dir)) {
      const content = readFileSync(file, "utf-8");
      for (const secret of secrets) expect(content.includes(secret), `${file} contains a secret`).toBe(false);
    }
    expect(text).not.toContain("\"demo-a\"");
  }, 120_000);
});
