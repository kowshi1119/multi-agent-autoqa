import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logger.js";
import { parseProfile } from "../../src/profiles/schema.js";
import { profileToAppConfig } from "../../src/profiles/to-app-config.js";
import { runPreflight } from "../../src/preflight/doctor.js";
import { MockModelProvider } from "../../src/models/provider-implementation.js";

let server: Server;
let ORIGIN: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>ok</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const port = (server.address() as AddressInfo).port;
  ORIGIN = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const originalAnthropicKey = process.env["ANTHROPIC_API_KEY"];
const originalExplabsKey = process.env["EXPLABS_API_KEY"];

afterEach(() => {
  if (originalAnthropicKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = originalAnthropicKey;
  if (originalExplabsKey === undefined) delete process.env["EXPLABS_API_KEY"];
  else process.env["EXPLABS_API_KEY"] = originalExplabsKey;
});

function fixtureProfile(overrides: (raw: Record<string, unknown>) => void = () => {}) {
  const raw = {
    schemaVersion: 1,
    id: "test-fixture",
    name: "Test",
    target: { url: `${ORIGIN}/`, environmentKind: "local-fixture" },
    navigation: { allowedOrigins: [ORIGIN], allowedPathPrefixes: ["/"] },
    resources: { allowedApiOrigins: [ORIGIN] },
    workflows: { allowedWorkflowKinds: ["navigate"] },
    auth: { mode: "none" },
    provider: {
      explorer: { provider: "mock" },
      critic: { enabled: true, provider: "mock", requireIndependentProvider: false, maxCallsPerFinding: 1 },
      providerTimeoutMs: 30000,
    },
    limits: { maxActions: 10, maxModelCalls: 10, maxPages: 5, maxFindings: 5, maxDurationMs: 60000, maxCriticCalls: 5 },
  };
  overrides(raw);
  return parseProfile(raw);
}

describe("runPreflight", () => {
  it("reports overallReady=true for a fully valid, reachable, mock-provider fixture profile", async () => {
    const profile = fixtureProfile();
    const config = profileToAppConfig(profile);
    const report = await runPreflight(profile, config, createLogger());
    expect(report.overallReady).toBe(true);
    expect(report.checks.every((c) => c.status !== "fail")).toBe(true);
  });

  it("fails the target-reachable check for an unreachable port, with a bounded timeout", async () => {
    const closedPortProfile = fixtureProfile((raw) => {
      (raw["target"] as Record<string, unknown>)["url"] = "http://localhost:1/";
      (raw["navigation"] as Record<string, unknown>)["allowedOrigins"] = ["http://localhost:1"];
    });
    const config = profileToAppConfig(closedPortProfile);
    const started = Date.now();
    const report = await runPreflight(closedPortProfile, config, createLogger());
    const elapsedMs = Date.now() - started;
    const targetCheck = report.checks.find((c) => c.id === "target-reachable");
    expect(targetCheck?.status).toBe("fail");
    expect(report.overallReady).toBe(false);
    expect(elapsedMs).toBeLessThan(15_000);
  }, 20_000);

  it("fails scope-consistency when the target origin isn't in allowedOrigins", async () => {
    const badProfile = fixtureProfile((raw) => {
      (raw["navigation"] as Record<string, unknown>)["allowedOrigins"] = ["http://localhost:9999"];
    });
    const config = profileToAppConfig(badProfile);
    const report = await runPreflight(badProfile, config, createLogger());
    const scopeCheck = report.checks.find((c) => c.id === "scope-consistency");
    expect(scopeCheck?.status).toBe("fail");
  });

  it("fails the provider check when a live provider is selected with no credential set", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const profile = fixtureProfile((raw) => {
      (raw["provider"] as Record<string, unknown>)["explorer"] = { provider: "anthropic", model: "claude-x" };
    });
    const config = profileToAppConfig(profile);
    const report = await runPreflight(profile, config, createLogger());
    const providerCheck = report.checks.find((c) => c.id === "providers");
    expect(providerCheck?.status).toBe("fail");
    expect(report.overallReady).toBe(false);
  });

  it("skips the auth-config check when auth.mode is none", async () => {
    const profile = fixtureProfile();
    const config = profileToAppConfig(profile);
    const report = await runPreflight(profile, config, createLogger());
    const authCheck = report.checks.find((c) => c.id === "auth-config");
    expect(authCheck?.status).toBe("skipped");
  });

  it("never makes a live model call as a side effect of a bare doctor run (mock provider spy count 0)", async () => {
    const profile = fixtureProfile();
    const config = profileToAppConfig(profile);
    const spy = vi.spyOn(MockModelProvider.prototype, "decideNextAction");
    await runPreflight(profile, config, createLogger());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
