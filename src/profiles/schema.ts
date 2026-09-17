import { z } from "zod";
import { elementTargetSchema } from "../actions.js";
import { configSchema, modelsSchema, originSchema } from "../config.js";

/**
 * Additive layer alongside configSchema (src/config.ts), not a
 * replacement -- a ProjectProfile always projects into a full AppConfig
 * (see to-app-config.ts) so every existing "local-fixture" string-equality
 * check throughout the codebase keeps working unchanged, and a legacy
 * qa.config.yaml loaded directly via loadConfig() is entirely unaffected.
 *
 * A profile never stores a secret. `auth` holds only locator/selector
 * metadata describing HOW to log in; the actual username/password are
 * transient run input (src/auth/session-bootstrap.ts's
 * TransientCredentials), never written to a profile file.
 */
export const environmentKindSchema = z.enum(["local-fixture", "self-hosted-real-app", "owned-sandbox"]);
export type EnvironmentKind = z.infer<typeof environmentKindSchema>;

/**
 * Reuses the exact same locator shape (role/name/label/text/testId) that
 * QaAction targets already use in src/actions.ts -- a login form field is
 * resolved through the same buildLocator()-style logic as every other
 * click/fill, not a second, independently-typed selector language.
 */
const authSchema = z
  .object({
    mode: z.enum(["none", "form-login"]),
    checksVerified: z.boolean().optional(),
    allowedRequests: z.array(z.object({ origin: originSchema, method: z.enum(["POST"]), pathname: z.string().startsWith("/") })).optional(),
    loginUrl: z.string().url().optional(),
    usernameField: elementTargetSchema.optional(),
    passwordField: elementTargetSchema.optional(),
    submitControl: elementTargetSchema.optional(),
    successUrlPattern: z.string().optional(),
    authenticatedSignal: elementTargetSchema.optional(),
  })
  .superRefine((auth, ctx) => {
    if (auth.mode !== "form-login") return;
    const required: Array<keyof typeof auth> = [
      "loginUrl",
      "usernameField",
      "passwordField",
      "submitControl",
      "successUrlPattern",
      "authenticatedSignal",
    ];
    for (const field of required) {
      if (!auth[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `auth.${field} is required when auth.mode is "form-login"`,
        });
      }
    }
    if (auth.successUrlPattern) {
      try {
        new RegExp(auth.successUrlPattern);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["successUrlPattern"],
          message: `auth.successUrlPattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  });

const workflowKindSchema = z.enum(["navigate", "search", "filter", "sort", "paginate"]);

export const projectProfileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1, "id must not be empty"),
  name: z.string().min(1, "name must not be empty"),
  target: z.object({
    url: z.string().url("target.url must be a valid URL"),
    environmentKind: environmentKindSchema,
  }),
  navigation: z.object({
    allowedOrigins: z.array(originSchema).min(1, "navigation.allowedOrigins must contain at least one origin"),
    allowedPathPrefixes: z.array(z.string()).default([]),
  }),
  resources: z.object({
    allowedApiOrigins: z.array(originSchema).default([]),
    /**
     * Explicit allowlist of (method, pathname) pairs a real-target profile
     * may actually submit a form or fire a state-changing request to --
     * login, and any verified read-only search/filter/sort endpoint,
     * regardless of whether it happens to use GET or POST. HTTP method
     * alone never proves safety in either direction: every other form
     * submit and every other state-changing XHR/fetch is denied by
     * default (see src/safety/action-policy.ts). A read-only workflow must
     * be explicitly identified here, never assumed from GET.
     */
    allowedFormSubmitEndpoints: z
      .array(
        z.object({
          method: z.string().min(1),
          pathname: z.string().min(1).startsWith("/"),
        })
      )
      .default([]),
  }),
  workflows: z.object({
    allowedWorkflowKinds: z.array(workflowKindSchema).default([]),
    executionMode: z.enum(["heuristics", "declared"]).optional(),
  }),
  auth: authSchema,
  requirements: configSchema.innerType().shape.requirements.optional(),
  oracles: configSchema.innerType().shape.oracles.optional(),
  provider: modelsSchema,
  limits: z.object({
    maxActions: z.number().int().positive(),
    maxModelCalls: z.number().int().positive(),
    maxPages: z.number().int().positive(),
    maxFindings: z.number().int().positive(),
    maxDurationMs: z.number().int().positive().finite(),
    maxCriticCalls: z.number().int().positive(),
  }),
});

export type ProjectProfile = z.infer<typeof projectProfileSchema>;

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export function parseProfile(raw: unknown): ProjectProfile {
  const result = projectProfileSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}:\n  ${issue.message}`);
    throw new ProfileError(`AutoQA profile error\n\n${lines.join("\n\n")}`);
  }
  return result.data;
}
