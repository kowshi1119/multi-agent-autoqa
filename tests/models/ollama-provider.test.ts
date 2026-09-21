import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetTracker, ModelBudgetExhaustedError } from "../../src/budget.js";
import { ConfigError } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { assertLocalOnlyUrl, OllamaModelProvider, OllamaProviderError } from "../../src/models/ollama-provider.js";
import { ModelOutputInvalidError } from "../../src/models/provider.js";
import { UsageTracker } from "../../src/models/usage-tracker.js";
import { ModelRouter } from "../../src/models/model-router.js";
import { selectProvider } from "../../src/run-pipeline.js";
import { redactSecrets } from "../../src/redact.js";
import type { ExplorerInput } from "../../src/types.js";
import { loadTestConfig } from "../helpers/test-config.js";

const baseUrl = "http://127.0.0.1:11434";
const model = "ollama-test-model";
const decision = { candidateId: "nav-home", testingIntent: "View home", reason: "Approved navigation" };
const fetchMock = vi.fn<typeof fetch>();
const logger = createLogger();
logger.level = "silent";

function input(): ExplorerInput {
  return {
    observation: {
      timestamp: "2026-09-21T00:00:00Z", page: { url: "http://localhost/", title: "Home", pathname: "/" },
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
function response(content = JSON.stringify(decision), extra: Record<string, unknown> = { prompt_eval_count: 10, eval_count: 5 }): Response {
  return new Response(JSON.stringify({ message: { role: "assistant", content }, done: true, ...extra }), { status: 200, headers: { "content-type": "application/json" } });
}
function requestBody(index = 0): any {
  return JSON.parse(String(fetchMock.mock.calls[index]![1]?.body));
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => { throw new Error("Unexpected offline test request"); });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("assertLocalOnlyUrl", () => {
  it("accepts loopback hosts only", () => {
    expect(assertLocalOnlyUrl("http://127.0.0.1:11434").hostname).toBe("127.0.0.1");
    expect(assertLocalOnlyUrl("http://localhost:11434").hostname).toBe("localhost");
  });
  it.each([
    "https://127.0.0.1:11434", // wrong scheme
    "http://example.com:11434", // remote host
    "http://evil.example.com/127.0.0.1", // remote host with loopback-looking path
    "not a url",
  ])("rejects a non-loopback or malformed URL: %s", (url) => {
    expect(() => assertLocalOnlyUrl(url)).toThrow(ConfigError);
  });
});

describe("Ollama Explorer through a fake local HTTP boundary", () => {
  it("sends the existing prompt/schema to /api/chat and records token usage", async () => {
    fetchMock.mockResolvedValueOnce(response());
    const usage = new UsageTracker();
    const limits = budget();
    const provider = new OllamaModelProvider(baseUrl, model, logger, usage, limits);
    expect(await provider.decideNextAction(input())).toEqual(decision);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://127.0.0.1:11434/api/chat");
    const body = requestBody();
    expect(body.model).toBe(model);
    expect(body.stream).toBe(false);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("You do NOT decide");
    expect(body.format.properties.candidateId.enum).toEqual(["nav-home", "stop"]);
    expect(body.format.additionalProperties).toBe(false);
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe("manual");
    expect(limits.modelCalls).toBe(1);
    expect(usage.summary().explorer).toEqual({ requests: 1, tokenUsage: { input: 10, output: 5 } });
  });

  it("performs one counted repair with the original context, without echoing unsafe output", async () => {
    const secret = "transient-password-value";
    fetchMock.mockResolvedValueOnce(response(`malformed ${secret}`)).mockResolvedValueOnce(response());
    const usage = new UsageTracker();
    const limits = budget();
    expect(await new OllamaModelProvider(baseUrl, model, logger, usage, limits).decideNextAction(input())).toEqual(decision);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(limits.modelCalls).toBe(2);
    expect(usage.summary().explorer.requests).toBe(2);
    expect(requestBody(1).messages[1].content).toContain("View home");
  });

  it.each([
    JSON.stringify({ ...decision, candidateId: "invented-action" }),
    JSON.stringify({ ...decision, confirmedBug: true }),
    JSON.stringify({ executionStatus: "PASS", evidence: ["made-up.png"] }),
    "not json",
    "",
  ])("rejects invalid or authority-expanding output after one repair: %s", async (content) => {
    fetchMock.mockImplementation(async () => response(content));
    await expect(new OllamaModelProvider(baseUrl, model, logger).decideNextAction(input())).rejects.toBeInstanceOf(ModelOutputInvalidError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cannot select a candidate outside the displayed first 25", async () => {
    const data = input();
    data.candidates = Array.from({ length: 26 }, (_, i) => ({ ...data.candidates[0]!, id: `candidate-${i}` }));
    fetchMock.mockImplementation(async () => response(JSON.stringify({ ...decision, candidateId: "candidate-25" })));
    await expect(new OllamaModelProvider(baseUrl, model, logger).decideNextAction(data)).rejects.toBeInstanceOf(ModelOutputInvalidError);
    expect(requestBody().format.properties.candidateId.enum).not.toContain("candidate-25");
  });

  it("refuses a repair when it would exceed the request budget", async () => {
    fetchMock.mockResolvedValueOnce(response("bad json"));
    const limits = budget(1);
    const usage = new UsageTracker();
    await expect(new OllamaModelProvider(baseUrl, model, logger, usage, limits).decideNextAction(input())).rejects.toBeInstanceOf(ModelBudgetExhaustedError);
    expect(limits.modelCalls).toBe(1);
    expect(usage.summary().explorer.requests).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes no request after cancellation or budget exhaustion", async () => {
    const limits = budget(0);
    const provider = new OllamaModelProvider(baseUrl, model, logger, undefined, limits);
    await expect(provider.decideNextAction(input())).rejects.toBeInstanceOf(ModelBudgetExhaustedError);
    await expect(provider.decideNextAction(input(), AbortSignal.abort("stop"))).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limits.modelCalls).toBe(0);
  });

  it("aborts an in-flight request and records the failed attempt", async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      transportSignal = init?.signal;
      transportSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      controller.abort("stop");
    }));
    const usage = new UsageTracker();
    await expect(new OllamaModelProvider(baseUrl, model, logger, usage).decideNextAction(input(), controller.signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect(transportSignal?.aborted).toBe(true);
    expect(usage.getAttempts()[0]?.outcome).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out a hanging request without retrying or calling it an application failure", async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const usage = new UsageTracker();
    await expect(new OllamaModelProvider(baseUrl, model, logger, usage, undefined, 20).decideNextAction(input())).rejects.toMatchObject({ kind: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(usage.getAttempts()[0]?.outcome).toBe("timeout");
  });

  it("distinguishes connection-refused from a 404 missing model, without leaking the response body", async () => {
    fetchMock.mockImplementationOnce(async () => { throw new Error("ECONNREFUSED 127.0.0.1:11434"); });
    const refused = await new OllamaModelProvider(baseUrl, model, logger).decideNextAction(input()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OllamaProviderError);
    expect(refused).toMatchObject({ kind: "server_unavailable" });

    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: `model "${model}" not found, try pulling it first` }), { status: 404 }));
    const missing = await new OllamaModelProvider(baseUrl, model, logger).decideNextAction(input()).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(OllamaProviderError);
    expect(missing).toMatchObject({ kind: "model_not_found" });
    expect(String(missing)).not.toContain("try pulling it first");
  });

  it("refuses to follow a redirect instead of silently leaving loopback", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: "http://evil.example.com/api/chat" } }));
    const error = await new OllamaModelProvider(baseUrl, model, logger).decideNextAction(input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OllamaProviderError);
    expect(error).toMatchObject({ kind: "server_unavailable" });
  });

  it("keeps missing token usage unknown rather than fabricating zero", async () => {
    fetchMock.mockResolvedValueOnce(response(JSON.stringify(decision), {}));
    const usage = new UsageTracker();
    await new OllamaModelProvider(baseUrl, model, logger, usage).decideNextAction(input());
    expect(usage.summary().explorer.tokenUsage).toBeNull();
  });

  it("redacts transient secrets from the request and result", async () => {
    const data = input();
    data.extraSecrets = ["transient-password-value"];
    data.observation.visibleText = "Home transient-password-value";
    data.candidates[0]!.description = "Visit transient-password-value";
    fetchMock.mockResolvedValueOnce(response(JSON.stringify({ ...decision, reason: "transient-password-value" })));
    const result = await new OllamaModelProvider(baseUrl, model, logger).decideNextAction(data);
    expect(JSON.stringify(requestBody())).not.toContain("transient-password-value");
    expect(JSON.stringify(result)).not.toContain("transient-password-value");
    expect(redactSecrets("transient-password-value", ["transient-password-value"])).not.toContain("transient-password-value");
  });
});

describe("Ollama configuration and routing", () => {
  it("requires a non-empty model and a loopback base URL, without making a request", () => {
    expect(() => new OllamaModelProvider(baseUrl, " ", logger)).toThrow(ConfigError);
    expect(() => new OllamaModelProvider("http://example.com:11434", model, logger)).toThrow(ConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves Ollama through selectProvider/ModelRouter with no credential required", async () => {
    const config = loadTestConfig();
    config.models.explorer = { provider: "ollama", model };
    const router = new ModelRouter(selectProvider(config, logger), null);
    expect(router.getExplorer()).toBeInstanceOf(OllamaModelProvider);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors OLLAMA_BASE_URL and defaults to 127.0.0.1:11434 when unset", () => {
    const config = loadTestConfig();
    config.models.explorer = { provider: "ollama", model };
    vi.stubEnv("OLLAMA_BASE_URL", "");
    expect(() => selectProvider(config, logger)).not.toThrow();
    vi.stubEnv("OLLAMA_BASE_URL", "http://evil.example.com:11434");
    expect(() => selectProvider(config, logger)).toThrow(ConfigError);
    vi.unstubAllEnvs();
  });
});
