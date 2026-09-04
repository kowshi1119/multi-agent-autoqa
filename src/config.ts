import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const originSchema = z
  .string()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.origin === value;
    } catch {
      return false;
    }
  }, "must be a valid origin, e.g. http://localhost:4173");

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
    }),
    heuristics: z.object({
      longTextBoundaryChars: z
        .number()
        .int()
        .positive("heuristics.longTextBoundaryChars must be > 0")
        .max(5_000, "heuristics.longTextBoundaryChars must stay well below attack-scale lengths"),
    }),
    validation: z.object({
      attempts: z.number().int().min(1, "validation.attempts must be >= 1"),
      minimumSuccesses: z.number().int().min(1, "validation.minimumSuccesses must be >= 1"),
    }),
    oracles: z.object({
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
    return {
      headless: true,
      reason: "no DISPLAY detected",
    };
  }

  return {
    headless: config.browser.headless,
    reason: `DISPLAY detected, using configured value (${config.browser.headless})`,
  };
}
