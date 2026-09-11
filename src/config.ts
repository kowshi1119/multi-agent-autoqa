import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const originSchema = z
  .string()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.origin === value;
    } catch {
      return false;
    }
  }, "must be a valid origin, e.g. http://localhost:4173");

/** Extracted for reuse by src/profiles/schema.ts -- profiles carry the same explorer/critic provider shape as AppConfig.models, not a reinvented one. */
export const modelsSchema = z.object({
  explorer: z.object({
    provider: z.enum(["auto", "mock", "anthropic", "openai", "ollama", "explabs"]),
    model: z.string().optional(),
  }),
  critic: z.object({
    enabled: z.boolean(),
    provider: z.enum(["mock", "anthropic", "openai", "ollama", "explabs"]),
    model: z.string().optional(),
    requireIndependentProvider: z.boolean(),
    maxCallsPerFinding: z.number().int().positive("models.critic.maxCallsPerFinding must be > 0"),
  }),
  providerTimeoutMs: z.number().int().positive("models.providerTimeoutMs must be > 0"),
});

const configSchema = z
  .object({
    project: z.object({
      name: z.string().min(1, "project.name must not be empty"),
    }),
    target: z.object({
      url: z.string().url("target.url must be a valid URL"),
      environment: z.string().min(1, "target.environment must not be empty"),
    }),
    browser: z.object({
      engine: z.literal("chromium", {
        errorMap: () => ({ message: "browser.engine must be \"chromium\" in Phase 0" }),
      }),
      headless: z.boolean(),
      viewport: z.object({
        width: z.number().int().positive("browser.viewport.width must be > 0"),
        height: z.number().int().positive("browser.viewport.height must be > 0"),
      }),
    }),
    agent: z.object({
      maxActions: z.number().int().positive("agent.maxActions must be > 0"),
      maxModelCalls: z.number().int().positive("agent.maxModelCalls must be > 0"),
      maxPages: z.number().int().positive("agent.maxPages must be > 0"),
      maxFindings: z.number().int().positive("agent.maxFindings must be > 0"),
      maxDurationMs: z
        .number()
        .int()
        .positive("agent.maxDurationMs must be a positive finite integer")
        .finite("agent.maxDurationMs must be a positive finite integer"),
      maxCriticCalls: z.number().int().positive("agent.maxCriticCalls must be > 0"),
    }),
    heuristics: z.object({
      longTextBoundaryChars: z
        .number()
        .int()
        .positive("heuristics.longTextBoundaryChars must be > 0")
        .max(5_000, "heuristics.longTextBoundaryChars must stay well below attack-scale lengths"),
      safeControlClick: z.object({
        enabled: z.boolean(),
        allowedControls: z.array(z.string()),
      }),
    }),
    validation: z.object({
      attempts: z.number().int().min(1, "validation.attempts must be >= 1"),
      minimumSuccesses: z.number().int().min(1, "validation.minimumSuccesses must be >= 1"),
    }),
    oracles: z.object({
      uiApiConsistency: z.object({
        enabled: z.boolean(),
        rules: z.array(
          z.object({
            id: z.string().min(1, "oracles.uiApiConsistency.rules[].id must not be empty"),
            request: z.object({
              method: z.string().min(1, "oracles.uiApiConsistency.rules[].request.method must not be empty"),
              pathname: z
                .string()
                .min(1)
                .startsWith("/", "oracles.uiApiConsistency.rules[].request.pathname must start with /"),
            }),
            failureStatusMin: z
              .number()
              .int()
              .min(400, "oracles.uiApiConsistency.rules[].failureStatusMin must be >= 400")
              .max(599, "oracles.uiApiConsistency.rules[].failureStatusMin must be <= 599"),
            forbiddenVisibleText: z
              .string()
              .min(1, "oracles.uiApiConsistency.rules[].forbiddenVisibleText must not be empty"),
          })
        ),
      }),
      console: z.object({
        enabled: z.boolean(),
        ignorePatterns: z.array(z.string()),
      }),
      pageError: z.object({
        enabled: z.boolean(),
      }),
      httpFailure: z.object({
        enabled: z.boolean(),
      }),
      duplicateRequest: z.object({
        enabled: z.boolean(),
        patterns: z.array(
          z.object({
            method: z.string().min(1, "oracles.duplicateRequest.patterns[].method must not be empty"),
            pathname: z
              .string()
              .min(1)
              .startsWith("/", "oracles.duplicateRequest.patterns[].pathname must start with /"),
            expectedMax: z
              .number()
              .int()
              .min(1, "oracles.duplicateRequest.patterns[].expectedMax must be >= 1"),
          })
        ),
      }),
    }),
    evidence: z.object({
      screenshots: z.boolean(),
      trace: z.boolean(),
      console: z.boolean(),
      network: z.boolean(),
    }),
    models: modelsSchema,
    requirements: z
      .object({
        enabled: z.boolean(),
        path: z.string().min(1, "requirements.path must not be empty"),
      })
      .default({ enabled: false, path: "requirements.yaml" }),
    /** Cross-finding grouping (Phase 3): off by default, exact Phase-2 behavior unless explicitly opted in. */
    grouping: z.object({ enabled: z.boolean() }).default({ enabled: false }),
    safety: z.object({
      safeMode: z.boolean(),
      allowedOrigins: z
        .array(originSchema)
        .min(1, "safety.allowedOrigins must contain at least one origin"),
    }),
  })
  .superRefine((config, ctx) => {
    if (config.validation.minimumSuccesses > config.validation.attempts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validation", "minimumSuccesses"],
        message: "must not exceed validation.attempts",
      });
    }
    if (config.models.explorer.provider !== "auto" && config.models.explorer.provider !== "mock" && !config.models.explorer.model?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["models", "explorer", "model"],
        message: `models.explorer.model is required when models.explorer.provider is "${config.models.explorer.provider}"`,
      });
    }
    if (
      config.models.critic.enabled &&
      config.models.critic.provider !== "mock" &&
      !config.models.critic.model?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["models", "critic", "model"],
        message: `models.critic.model is required when models.critic.provider is "${config.models.critic.provider}"`,
      });
    }
    // Literal string comparison only — this cannot see the runtime "auto" ->
    // provider resolution ANTHROPIC_API_KEY drives (that happens later, in
    // run-pipeline.ts). A config-time check that read process.env would
    // break config.ts's current purity and make "no run artifacts on this
    // error" harder to guarantee (index.ts creates runDir/run.log before
    // runPipeline() runs). Documented, disclosed gap: only literal
    // explorer.provider === critic.provider is caught here.
    if (
      config.models.critic.enabled &&
      config.models.critic.requireIndependentProvider &&
      config.models.explorer.provider === config.models.critic.provider
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["models", "critic", "requireIndependentProvider"],
        message:
          "MODEL_ROLE_CONFIGURATION_ERROR: critic.requireIndependentProvider=true but explorer and critic use the same provider.",
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function formatZodError(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.join(".") || "(root)";
    return `${path}:\n  ${issue.message}`;
  });
  return `AutoQA configuration error\n\n${lines.join("\n\n")}`;
}

function findInlineCredential(value: unknown, path: string[] = []): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findInlineCredential(item, [...path, String(index)]);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;

  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = [...path, key];
    if (/^(api_?key|authorization|token|secret|password)$/i.test(key) && typeof nested === "string" && nested) {
      return nestedPath.join(".");
    }
    const found = findInlineCredential(nested, nestedPath);
    if (found) return found;
  }
  return undefined;
}

export function loadConfig(configPath: string): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `AutoQA configuration error\n\nCould not read configuration file at ${configPath}\n${cause}`
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `AutoQA configuration error\n\nInvalid YAML in ${configPath}\n${cause}`
    );
  }

  const inlineCredentialPath = findInlineCredential(parsed);
  if (inlineCredentialPath) {
    throw new ConfigError(
      `MODEL_CONFIGURATION_ERROR: inline credential at ${inlineCredentialPath} is not allowed; use a local environment variable.`
    );
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error));
  }

  return result.data;
}

/**
 * Playwright launch headlessness follows the environment, not just the config:
 * a missing DISPLAY means no X server is available, so a headed browser
 * would fail to launch regardless of what qa.config.yaml requests.
 */
export function resolveHeadless(config: AppConfig): {
  headless: boolean;
  reason: string;
} {
  const hasDisplay = Boolean(process.env["DISPLAY"]);

  if (!hasDisplay) {
    // DISPLAY is an X11/POSIX concept, normally absent on Windows -- don't
    // phrase this as "no X11 display detected" (implies a check that only
    // meaningfully runs on POSIX); "forced" + "no virtual display detected"
    // reads correctly on every platform this runs on.
    return {
      headless: true,
      reason: "forced (no virtual display detected)",
    };
  }

  return {
    headless: config.browser.headless,
    reason: `DISPLAY detected, using configured value (${config.browser.headless})`,
  };
}
