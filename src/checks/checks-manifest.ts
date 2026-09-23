import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Mirrors src/pilot/workflow-manifest.ts's own <profileId>.<x>.json load pattern. */
export class ChecksManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecksManifestError";
  }
}

const shapeFieldTypeSchema = z.enum(["string", "number", "boolean", "array", "object"]);

const invariantSchema = z.object({
  kind: z.enum(["range", "fieldsEqual", "fieldLessThan"]),
  field: z.string().min(1),
  field2: z.string().min(1).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

export const declaredApiCheckSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  pathname: z.string().min(1).startsWith("/"),
  description: z.string().min(1),
  requestBody: z.unknown().optional(),
  assertions: z.object({
    expectedStatus: z.number().int().optional(),
    expectedContentType: z.string().optional(),
    /** Dot-paths into the parsed JSON response body, e.g. "user.id". */
    requiredFields: z.array(z.string().min(1)).optional(),
    shape: z.record(shapeFieldTypeSchema).optional(),
    invariants: z.array(invariantSchema).max(5).default([]),
  }),
});
export type DeclaredApiCheck = z.infer<typeof declaredApiCheckSchema>;

export const declaredSecurityCheckSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  kind: z.enum(["cookie-attributes", "security-headers", "secret-leakage", "session-boundary"]),
  pathname: z.string().min(1).startsWith("/"),
  description: z.string().min(1),
  /** Required, and only meaningful, for kind:"session-boundary". */
  sessionBoundary: z
    .object({
      loginPathname: z.string().min(1).startsWith("/"),
      accountAId: z.string().min(1),
      accountBId: z.string().min(1),
      /** Pathname template with "{accountId}" replaced per attempt, e.g. "/api/account/{accountId}/resource". */
      resourcePathnameTemplate: z.string().min(1).startsWith("/"),
    })
    .optional(),
});
export type DeclaredSecurityCheck = z.infer<typeof declaredSecurityCheckSchema>;

export const checksManifestSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  apiChecks: z.array(declaredApiCheckSchema).default([]),
  securityChecks: z.array(declaredSecurityCheckSchema).default([]),
});
export type ChecksManifest = z.infer<typeof checksManifestSchema>;

function manifestPath(profilesDir: string, profileId: string): string {
  return join(profilesDir, `${profileId}.checks.json`);
}

/** Absent (undefined) is the honest default for a profile with no declared checks -- mirrors loadWorkflowManifest()'s own convention. */
export function loadChecksManifest(profilesDir: string, profileId: string): ChecksManifest | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(profileId)) throw new ChecksManifestError("Invalid profile ID");
  const path = manifestPath(profilesDir, profileId);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new ChecksManifestError(`AutoQA checks-manifest error\n\nInvalid JSON in ${path}\n${cause}`);
  }
  const result = checksManifestSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}:\n  ${issue.message}`);
    throw new ChecksManifestError(`AutoQA checks-manifest error\n\n${lines.join("\n\n")}`);
  }
  if (result.data.profileId !== profileId) throw new ChecksManifestError("Manifest profile ID mismatch");
  return result.data;
}
