import pino from "pino";
import { redactSecrets } from "./redact.js";

export type Logger = pino.Logger;

function redactLogArgument(value: unknown, extraSecrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, extraSecrets);
  if (Array.isArray(value)) return value.map((v) => redactLogArgument(v, extraSecrets));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactLogArgument(nested, extraSecrets)]));
}

/**
 * Structured audit log (JSON lines) written to run.log. The human-readable
 * narrative shown in the terminal (checkmarks, "Explorer: ...", the final
 * summary block) is printed separately via plain console.log in index.ts;
 * this logger is the machine-readable trail, not the terminal UI.
 *
 * `extraSecrets` (Phase 4 continuation) carries this run's transient,
 * non-env credential values (see redact.ts#credentialSecrets) so a
 * UI-submitted password is scrubbed from every log line this logger
 * writes, the same as an env-sourced one already was.
 */
/**
 * Fields a minimal-evidence run log may keep (src/privacy/evidence-policy.ts):
 * identifiers, states, codes and counts. Any other field of a logged object
 * is dropped and its NAME recorded under `omittedFields`, so the log still
 * says that something was left out without saying what it contained.
 */
const MINIMAL_LOG_FIELDS = new Set([
  "runId", "workflowId", "checkId", "findingId", "oracleId", "heuristicId", "suiteId", "profileId", "requestId",
  "phase", "state", "status", "outcome", "code", "reasonCode", "kind", "provider", "mode", "level",
  "count", "counts", "attempt", "attempts", "durationMs", "elapsedMs", "actionsUsed", "modelCalls", "used", "max", "remaining",
]);

function minimalLogArgument(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\bhttps?:\/\/\S+/g, "<url omitted>");
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return typeof value === "object" && value !== null ? { omitted: "non-plain value" } : value;
  const kept: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    if (MINIMAL_LOG_FIELDS.has(key) && (typeof nested === "number" || typeof nested === "boolean" || (typeof nested === "string" && nested.length <= 80 && !/https?:\/\//.test(nested)))) kept[key] = nested;
    else omitted.push(key);
  }
  return omitted.length ? { ...kept, omittedFields: omitted } : kept;
}

export function createLogger(logFilePath?: string, extraSecrets: readonly string[] = [], options: { minimal?: boolean } = {}): Logger {
  const loggerOptions: pino.LoggerOptions = {
    level: "debug",
    hooks: {
      logMethod(inputArgs, method) {
        // Minimal evidence: field allow-list BEFORE serialization, then the usual secret scrub.
        const args = options.minimal ? inputArgs.map(minimalLogArgument) : inputArgs;
        method.apply(this, args.map((a) => redactLogArgument(a, extraSecrets)) as never);
      },
    },
  };

  if (!logFilePath) {
    return pino(loggerOptions, pino.destination({ dest: 1, sync: false }));
  }

  return pino(
    loggerOptions,
    pino.destination({ dest: logFilePath, mkdir: true, sync: false })
  );
}
