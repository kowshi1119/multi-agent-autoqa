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
  server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/other-place" });
      res.end();
      return;
    }
    if (req.url === "/redirect-target-should-never-be-hit") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>you should never see this in a preflight test</body></html>");
      return;
    }
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
  it.each([
    { models: [{ name: "test-local" }], expected: "pass" },
    { models: [{ name: "another-model" }], expected: "fail" },
  ])("checks local model availability without inference: $expected", async ({ models, expected }) => {
    const previous = process.env["OLLAMA_BASE_URL"];
    process.env["OLLAMA_BASE_URL"] = "http://127.0.0.1:11434";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ models }), { status: 200 }),
    );
    try {
      const profile = fixtureProfile(raw => {
        (raw["provider"] as Record<string, unknown>)["explorer"] = { provider: "ollama", model: "test-local" };
      });
      const report = await runPreflight(profile, profileToAppConfig(profile), createLogger());
      expect(report.checks.find(c => c.id === "providers")?.status).toBe(expected);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("http://127.0.0.1:11434/api/tags");
      expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("manual");
    } finally {
      fetchSpy.mockRestore();
      if (previous === undefined) delete process.env["OLLAMA_BASE_URL"];
      else process.env["OLLAMA_BASE_URL"] = previous;
    }
  });

  it("reports unavailable local runtime without attempting inference or installation", async () => {
    const previous = process.env["OLLAMA_BASE_URL"];
    process.env["OLLAMA_BASE_URL"] = "http://127.0.0.1:11434";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    try {
      const profile = fixtureProfile(raw => {
        (raw["provider"] as Record<string, unknown>)["explorer"] = { provider: "ollama", model: "test-local" };
      });
      const report = await runPreflight(profile, profileToAppConfig(profile), createLogger());
      expect(report.overallReady).toBe(false);
      expect(report.checks.find(c => c.id === "providers")?.detail).toContain("Use Demo");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      if (previous === undefined) delete process.env["OLLAMA_BASE_URL"];
      else process.env["OLLAMA_BASE_URL"] = previous;
    }
  });

  it("reports overallReady=true for a fully valid, reachable, mock-provider fixture profile", async () => {
    const profile = fixtureProfile();
    const config = profileToAppConfig(profile);
    const report = await runPreflight(profile, config, createLogger());
    expect(report.overallReady).toBe(true);
    expect(report.checks.every((c) => c.status !== "fail")).toBe(true);
  });

  it("a local-fixture profile's target-reachable check is always 'managed', never actively probed -- even pointed at a port nothing listens on (Phase 4 continuation)", async () => {
    // The fixture's own server is started automatically only once a real
    // run begins (see run-pipeline.ts) -- actively probing it here, ahead
    // of any run, would always fail with connection-refused. That's
    // expected and must never block readiness for a fixture profile.
    const closedPortFixtureProfile = fixtureProfile((raw) => {
      (raw["target"] as Record<string, unknown>)["url"] = "http://localhost:1/";
      (raw["navigation"] as Record<string, unknown>)["allowedOrigins"] = ["http://localhost:1"];
    });
    const config = profileToAppConfig(closedPortFixtureProfile);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const report = await runPreflight(closedPortFixtureProfile, config, createLogger());
      const targetCheck = report.checks.find((c) => c.id === "target-reachable");
      expect(targetCheck?.status).toBe("managed");
      expect(report.overallReady).toBe(true);
      // Check the actual no-probe contract. The whole preflight also launches
      // Chromium, so its elapsed time cannot prove that no request occurred.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("fails the target-reachable check for a real-target profile pointed at an unreachable port, with a bounded timeout", async () => {
    const closedPortProfile = fixtureProfile((raw) => {
      (raw["target"] as Record<string, unknown>) = { url: "http://localhost:1/", environmentKind: "self-hosted-real-app" };
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

  it("skips the target-reachable probe entirely when scope-consistency fails first (2026-09-11 independent-review fix: previously probed before checking scope at all)", async () => {
    const badScopeProfile = fixtureProfile((raw) => {
      (raw["target"] as Record<string, unknown>) = { url: `${ORIGIN}/`, environmentKind: "self-hosted-real-app" };
      (raw["navigation"] as Record<string, unknown>)["allowedOrigins"] = ["http://localhost:9999"];
    });
    const config = profileToAppConfig(badScopeProfile);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const report = await runPreflight(badScopeProfile, config, createLogger());

    const scopeCheck = report.checks.find((c) => c.id === "scope-consistency");
    const targetCheck = report.checks.find((c) => c.id === "target-reachable");
    expect(scopeCheck?.status).toBe("fail");
    expect(targetCheck?.status).toBe("skipped");
    // The real assertion: no live request was ever issued to the
    // out-of-scope target, not even one -- confirmed by inspecting every
    // call the spy recorded, not merely trusting the reported status.
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes(ORIGIN))).toBe(true);
    expect(report.overallReady).toBe(false);
    fetchSpy.mockRestore();
  });

  it("skips the target-reachable probe when the target's PATH is out of scope, even though its origin is allowed (2026-09-14 addendum fix: scope-consistency previously never checked allowedPathPrefixes at all)", async () => {
    const outOfScopePathProfile = fixtureProfile((raw) => {
      (raw["target"] as Record<string, unknown>) = { url: `${ORIGIN}/outside-scope`, environmentKind: "self-hosted-real-app" };
      (raw["navigation"] as Record<string, unknown>)["allowedOrigins"] = [ORIGIN];
      (raw["navigation"] as Record<string, unknown>)["allowedPathPrefixes"] = ["/allowed"];
    });
    const config = profileToAppConfig(outOfScopePathProfile);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const report = await runPreflight(outOfScopePathProfile, config, createLogger());

    const scopeCheck = report.checks.find((c) => c.id === "scope-consistency");
    const targetCheck = report.checks.find((c) => c.id === "target-reachable");
    expect(scopeCheck?.status).toBe("fail");
    expect(targetCheck?.status).toBe("skipped");
    // As with the origin case above: the real assertion is that the
    // out-of-scope path was never actually requested, not merely that the
    // report says so.
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes("/outside-scope"))).toBe(true);
    expect(report.overallReady).toBe(false);
    fetchSpy.mockRestore();
  });

  it("reports a redirect response as reachable without following it to the redirect destination (2026-09-11 independent-review fix: previously followed redirects with zero scope checking on any hop)", async () => {
    const redirectingProfile = fixtureProfile((raw) => {
      (raw["target"] as Record<string, unknown>) = { url: `${ORIGIN}/redirect`, environmentKind: "self-hosted-real-app" };
    });
    const config = profileToAppConfig(redirectingProfile);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const report = await runPreflight(redirectingProfile, config, createLogger());

    const targetCheck = report.checks.find((c) => c.id === "target-reachable");
    expect(targetCheck?.status).toBe("pass");
    // Exactly one request -- the redirect destination was never fetched.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes("/redirect-target-should-never-be-hit"))).toBe(true);
    fetchSpy.mockRestore();
  });

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
