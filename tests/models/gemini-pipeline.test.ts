import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { runPipeline } from "../../src/run-pipeline.js";
import { assembleReport } from "../../src/reporting/assemble.js";
import { createLogger } from "../../src/logger.js";
import { loadTestConfig } from "../helpers/test-config.js";

const key = "fake-gemini-integration-secret";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Gemini pipeline and diagnostic integration (no live provider calls)", () => {
  it.each([false, true])("uses the shared browser pipeline and reports provider errors without invented findings (outage=%s)", async (outage) => {
    vi.stubEnv("GEMINI_API_KEY", key);
    const providerFetch = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (!String(url).startsWith("https://generativelanguage.googleapis.com/")) throw new Error("Unexpected test request");
      if (outage) return new Response(JSON.stringify({ error: { code: 503, message: key } }), { status: 503 });
      const body = JSON.parse(String(init?.body));
      const ids: string[] = body.generationConfig.responseJsonSchema.properties.candidateId.enum;
      const candidateId = ids.find((id) => id.startsWith("nav|"));
      expect(candidateId).toBeTruthy();
      return new Response(JSON.stringify({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ candidateId, testingIntent: "Navigate", reason: key }) }] } }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 },
      }));
    });
    vi.stubGlobal("fetch", providerFetch);
    const config = loadTestConfig();
    config.models.explorer = { provider: "gemini", model: "gemini-test-model" };
    config.agent.maxActions = 1;
    config.agent.maxModelCalls = 1;
    config.evidence.trace = false;
    config.models.critic.enabled = true;
    const runDir = mkdtempSync(join(tmpdir(), "autoqa-gemini-pipeline-"));
    const runId = "RUN-GEMINI-OFFLINE";
    const startedAt = new Date();
    const logger = createLogger();
    logger.level = "silent";
    const result = await runPipeline({ config, runDir, runId, logger, headless: true, requireLiveAuthorization: { argv: ["--live"] } });
    // The flag authorizes only this intercepted SDK transport, never a real API call.
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(result.budget.modelCalls).toBe(1);
    expect(result.modelRouter.getCritic()?.name).toBe("mock");
    expect(result.finalCtx.findings).toEqual([]);
    if (outage) {
      expect(result.finalCtx.state).toBe("FAILED");
      expect(result.finalCtx.stopReason).toContain("LLM_PROVIDER_ERROR");
      expect(result.finalCtx.actionsPerformed).toBe(0);
    } else {
      expect(result.finalCtx.state).not.toBe("FAILED");
      expect(result.finalCtx.actionsPerformed).toBe(1);
      expect(result.finalCtx.recordedSteps.some((step) => step.action.type === "navigate")).toBe(true);
    }
    const { report } = assembleReport(result, config, runId, runDir, startedAt);
    expect(report.provider.name).toBe("gemini");
    for (const filename of ["report.json", "report.md", "run-summary.json"]) {
      expect(readFileSync(join(runDir, filename), "utf8")).not.toContain(key);
    }
  }, 30_000);

  it("checks a selected Gemini config without a live request or credential output", () => {
    const output = execFileSync(process.execPath, [
      resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/provider-check.ts"),
      "--config", resolve("qa.config.gemini.yaml"),
    ], {
      cwd: mkdtempSync(join(tmpdir(), "autoqa-gemini-check-")),
      env: { ...process.env, GEMINI_API_KEY: key }, encoding: "utf8", timeout: 15_000,
    });
    expect(output).toContain("Provider: gemini");
    expect(output).toContain("Credential: available");
    expect(output).not.toContain("Live chat completion: succeeded");
    expect(output).not.toContain(key);
  });
});
