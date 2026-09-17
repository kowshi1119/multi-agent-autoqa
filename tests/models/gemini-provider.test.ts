import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BudgetTracker, ModelBudgetExhaustedError } from "../../src/budget.js";
import { ConfigError, modelsSchema } from "../../src/config.js";
import { Explorer } from "../../src/explorer.js";
import { createLogger } from "../../src/logger.js";
import { GeminiModelProvider, GeminiProviderError } from "../../src/models/gemini-provider.js";
import { ModelOutputInvalidError } from "../../src/models/provider.js";
import { UsageTracker } from "../../src/models/usage-tracker.js";
import { ModelRouter } from "../../src/models/model-router.js";
import { resolveProviderCredential } from "../../src/models/provider-credentials.js";
import { assertLiveModeAuthorized } from "../../src/models/live-gate.js";
import { selectProvider, selectCriticProvider } from "../../src/run-pipeline.js";
import { redactSecrets } from "../../src/redact.js";
import { parseProfile } from "../../src/profiles/schema.js";
import { profileToAppConfig } from "../../src/profiles/to-app-config.js";
import type { ExplorerInput } from "../../src/types.js";
import { loadTestConfig } from "../helpers/test-config.js";

const key = "fake-gemini-key-DO-NOT-USE";
const model = "gemini-test-model";
const decision = { candidateId: "nav-home", testingIntent: "View home", reason: "Approved navigation" };
const fetchMock = vi.fn<typeof fetch>();
const logger = createLogger();
logger.level = "silent";

function input(): ExplorerInput {
  return {
    observation: {
      timestamp: "2026-09-17T00:00:00Z", page: { url: "http://localhost/", title: "Home", pathname: "/" },
      viewport: { width: 1024, height: 768 }, visibleText: "Home", interactiveElements: [], forms: [], links: [],
      consoleMessages: [], pageErrors: [], networkRequests: [], dialogs: [], stateSignature: "home",
    },
    candidates: [{ id: "nav-home", description: "View home", kind: "navigation", risk: "safe", actions: [{ type: "navigate", url: "http://localhost/" }] }],
    recentActions: [], remainingActions: 5, remainingModelCalls: 5, remainingDurationMs: 60_000,
  };
}
function budget(maxModelCalls = 5): BudgetTracker {
  return new BudgetTracker({ maxActions: 5, maxModelCalls, maxPages: 5, maxFindings: 5, maxCriticCalls: 5, maxDurationMs: 60_000 });
}
function response(text = JSON.stringify(decision), usage: unknown = { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2 }): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: usage }), { status: 200, headers: { "content-type": "application/json" } });
}
function requestBody(index = 0): any {
  return JSON.parse(String(fetchMock.mock.calls[index]![1]?.body));
}
function fail(status: number): Response {
  return new Response(JSON.stringify({ error: { code: status, message: `secret=${key} upstream private body` } }), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GEMINI_API_KEY", key);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => { throw new Error("Unexpected offline test request"); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Gemini Explorer through the real SDK with an offline HTTP boundary", () => {
  it("sends the existing prompt/schema to the fixed endpoint and records output including thinking", async () => {
    vi.stubEnv("GOOGLE_GEMINI_BASE_URL", "https://untrusted.invalid");
    vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "true");
    fetchMock.mockResolvedValueOnce(response());
    const usage = new UsageTracker();
    const limits = budget();
    const provider = new GeminiModelProvider(key, logger, model, usage, limits);
    expect(await provider.decideNextAction(input())).toEqual(decision);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
    const body = requestBody();
    expect(body.systemInstruction.parts[0].text).toContain("You do NOT decide");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema.properties.candidateId.enum).toEqual(["nav-home", "stop"]);
    expect(body.generationConfig.responseJsonSchema.additionalProperties).toBe(false);
    expect(body.generationConfig.maxOutputTokens).toBe(2048);
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(key);
    expect(limits.modelCalls).toBe(1);
    expect(usage.summary().explorer).toEqual({ requests: 1, tokenUsage: { input: 10, output: 5 } });
  });

  it("performs one counted repair with the original context, without echoing unsafe output", async () => {
    fetchMock.mockResolvedValueOnce(response(`malformed ${key}`)).mockResolvedValueOnce(response());
    const usage = new UsageTracker();
    const limits = budget();
    expect(await new GeminiModelProvider(key, logger, model, usage, limits).decideNextAction(input())).toEqual(decision);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(limits.modelCalls).toBe(2);
    expect(usage.summary().explorer.requests).toBe(2);
    expect(requestBody(1).contents[0].parts[0].text).toContain("View home");
    expect(JSON.stringify(requestBody(1))).not.toContain(`malformed ${key}`);
  });

  it.each([
    JSON.stringify({ ...decision, candidateId: "invented-action" }),
    JSON.stringify({ ...decision, confirmedBug: true }),
    JSON.stringify({ executionStatus: "PASS", evidence: ["made-up.png"] }),
    "not json",
    "",
  ])("rejects invalid or authority-expanding output after one repair: %s", async (text) => {
    fetchMock.mockImplementation(async () => response(text));
    await expect(new GeminiModelProvider(key, logger, model).decideNextAction(input())).rejects.toBeInstanceOf(ModelOutputInvalidError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cannot select a candidate outside the displayed first 25", async () => {
    const data = input();
    data.candidates = Array.from({ length: 26 }, (_, i) => ({ ...data.candidates[0]!, id: `candidate-${i}` }));
    fetchMock.mockImplementation(async () => response(JSON.stringify({ ...decision, candidateId: "candidate-25" })));
    await expect(new GeminiModelProvider(key, logger, model).decideNextAction(data)).rejects.toBeInstanceOf(ModelOutputInvalidError);
    expect(requestBody().generationConfig.responseJsonSchema.properties.candidateId.enum).not.toContain("candidate-25");
  });

  it("refuses a repair when it would exceed the request budget", async () => {
    fetchMock.mockResolvedValueOnce(response("bad json"));
    const limits = budget(1);
    const usage = new UsageTracker();
    await expect(new GeminiModelProvider(key, logger, model, usage, limits).decideNextAction(input())).rejects.toBeInstanceOf(ModelBudgetExhaustedError);
    expect(limits.modelCalls).toBe(1);
    expect(usage.summary().explorer.requests).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes no request after cancellation or budget exhaustion", async () => {
    const limits = budget(0);
    const provider = new GeminiModelProvider(key, logger, model, undefined, limits);
    await expect(provider.decideNextAction(input())).rejects.toBeInstanceOf(ModelBudgetExhaustedError);
    await expect(provider.decideNextAction(input(), AbortSignal.abort(key))).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limits.modelCalls).toBe(0);
  });

  it("aborts an in-flight SDK transport and records the failed attempt", async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      transportSignal = init?.signal;
      transportSignal?.addEventListener("abort", () => reject(new Error(key)), { once: true });
      controller.abort(key);
    }));
    const usage = new UsageTracker();
    await expect(new GeminiModelProvider(key, logger, model, usage).decideNextAction(input(), controller.signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect(transportSignal?.aborted).toBe(true);
    expect(usage.getAttempts()[0]?.outcome).toBe("error");
    expect(JSON.stringify(usage.getAttempts())).not.toContain(key);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([[401, "authentication"], [403, "authentication"], [429, "rate_limit"], [404, "model_not_found"], [400, "invalid_request"], [413, "invalid_request"], [503, "unavailable"], [504, "timeout"]])("maps HTTP %s without retries or leaked SDK diagnostics", async (status, kind) => {
    fetchMock.mockImplementation(async () => fail(Number(status)));
    const usage = new UsageTracker();
    const error = await new GeminiModelProvider(key, logger, model, usage).decideNextAction(input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiProviderError);
    expect(error).toMatchObject({ kind });
    expect(String(error)).toContain("LLM_PROVIDER_ERROR");
    expect(String(error)).not.toContain(key);
    expect(String(error)).not.toContain("upstream private body");
    expect(error).not.toHaveProperty("cause");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(usage.getAttempts()[0]?.outcome).toBe(kind === "timeout" ? "timeout" : "error");
  });

  it("does not repair a blocked response or accept unsolicited function calls", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY", blockReasonMessage: key } })));
    const provider = new GeminiModelProvider(key, logger, model);
    await expect(provider.decideNextAction(input())).rejects.toMatchObject({ kind: "blocked_response" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: {} } }] } }] })));
    await expect(provider.decideNextAction(input())).rejects.toMatchObject({ kind: "unexpected_response" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps missing token usage unknown", async () => {
    fetchMock.mockResolvedValueOnce(response(JSON.stringify(decision), {}));
    const usage = new UsageTracker();
    await new GeminiModelProvider(key, logger, model, usage).decideNextAction(input());
    expect(usage.summary().explorer.tokenUsage).toBeNull();
  });

  it("redacts prompts, model decisions, logs, and repair output using provider and transient secrets", async () => {
    const data = input();
    data.extraSecrets = ["transient-password-value"];
    data.observation.visibleText = `${key} transient-password-value`;
    data.candidates[0]!.description = `Visit ${key}`;
    fetchMock.mockResolvedValueOnce(response(JSON.stringify({ ...decision, reason: `${key} transient-password-value` })));
    const result = await new GeminiModelProvider(key, logger, model).decideNextAction(data);
    expect(JSON.stringify(requestBody())).not.toContain(key);
    expect(JSON.stringify(requestBody())).not.toContain("transient-password-value");
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain("transient-password-value");
    const logPath = join(mkdtempSync(join(tmpdir(), "autoqa-gemini-log-")), "run.log");
    const fileLogger = createLogger(logPath);
    fileLogger.info({ reason: key }, key);
    await new Promise<void>((resolve, reject) => fileLogger.flush((error) => error ? reject(error) : resolve()));
    await expect.poll(() => readFileSync(logPath, "utf8")).toContain("<REDACTED>");
    expect(readFileSync(logPath, "utf8")).not.toContain(key);
    expect(redactSecrets(JSON.stringify({ reason: key }))).not.toContain(key);
    const shapedKey = `AIza${"a".repeat(35)}`;
    expect(redactSecrets(shapedKey)).toBe("<REDACTED>");
  });
});

describe("Gemini configuration, routing, and the existing Explorer", () => {
  it("requires a key and explicit model, without making a request", () => {
    expect(() => new GeminiModelProvider("", logger, model)).toThrow(ConfigError);
    expect(() => new GeminiModelProvider(key, logger, " ")).toThrow(ConfigError);
    const config = loadTestConfig();
    config.models.explorer = { provider: "gemini", model };
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(() => selectProvider(config, logger)).toThrow("GEMINI_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves Gemini through ModelRouter with the existing Critic unchanged", async () => {
    const config = loadTestConfig();
    config.models.explorer = { provider: "gemini", model };
    config.models.critic.enabled = true;
    const router = new ModelRouter(selectProvider(config, logger), selectCriticProvider(config, logger));
    expect(router.getExplorer()).toBeInstanceOf(GeminiModelProvider);
    expect(router.getCritic()?.name).toBe("mock");
    expect(resolveProviderCredential("gemini", "explorer")).toBe(key);
    expect(resolveProviderCredential("gemini", "critic")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response());
    const outcome = await new Explorer(router.getExplorer(), logger).decide(input());
    expect(outcome.kind).toBe("decision");
    if (outcome.kind === "decision") expect(outcome.candidate.actions).toEqual(input().candidates[0]!.actions);
    expect(outcome).not.toHaveProperty("confirmedBug");
  });

  it("supports profile mapping and YAML while rejecting Gemini Critic and unknown providers", () => {
    const config = loadTestConfig((yaml) => yaml.replace('provider: "mock"', 'provider: "gemini"\n    model: "gemini-test-model"'));
    expect(config.models.explorer.provider).toBe("gemini");
    const raw = JSON.parse(readFileSync("profiles/fixture.json", "utf8"));
    raw.provider.explorer = { provider: "gemini", model };
    expect(profileToAppConfig(parseProfile(raw)).models.explorer).toEqual({ provider: "gemini", model });
    expect(() => modelsSchema.parse({ ...config.models, critic: { ...config.models.critic, provider: "gemini" } })).toThrow();
    expect(() => modelsSchema.parse({ ...config.models, explorer: { provider: "unknown", model } })).toThrow();
    expect(() => loadTestConfig((yaml) => yaml.replace('provider: "mock"', 'provider: "gemini"'))).toThrow("model is required");
  });

  it("does not change auto-selection, existing providers, or the live authorization gate", () => {
    const config = loadTestConfig();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    config.models.explorer = { provider: "auto" };
    expect(selectProvider(config, logger).name).toBe("mock");
    vi.stubEnv("ANTHROPIC_API_KEY", "fake-anthropic");
    vi.stubEnv("EXPLABS_EXPLORER_API_KEY", "fake-explabs");
    for (const provider of ["anthropic", "explabs", "mock"] as const) {
      config.models.explorer = { provider, model: "test-model" };
      expect(selectProvider(config, logger).name).toBe(provider);
    }
    for (const provider of ["openai", "ollama"] as const) {
      config.models.explorer = { provider, model: "test-model" };
      expect(() => selectProvider(config, logger)).toThrow("not implemented");
    }
    config.models.explorer = { provider: "gemini", model };
    expect(() => assertLiveModeAuthorized(config, [])).toThrow("LIVE_MODE_NOT_AUTHORIZED");
    expect(() => assertLiveModeAuthorized(config, ["--live"])).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it("times out a hanging request without retrying or calling it an application failure", async () => {
  fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const usage = new UsageTracker();
  await expect(new GeminiModelProvider(key, logger, model, usage, undefined, 20).decideNextAction(input())).rejects.toMatchObject({ kind: "timeout" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(usage.getAttempts()[0]?.outcome).toBe("timeout");
});
