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
export function createLogger(logFilePath?: string, extraSecrets: readonly string[] = []): Logger {
  const loggerOptions: pino.LoggerOptions = {
    level: "debug",
    hooks: {
      logMethod(inputArgs, method) {
        method.apply(this, inputArgs.map((a) => redactLogArgument(a, extraSecrets)) as never);
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
