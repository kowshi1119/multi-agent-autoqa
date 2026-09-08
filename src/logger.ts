import pino from "pino";
import { redactSecrets } from "./redact.js";

export type Logger = pino.Logger;

function redactLogArgument(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactLogArgument);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactLogArgument(nested)]));
}

const loggerOptions: pino.LoggerOptions = {
  level: "debug",
  hooks: {
    logMethod(inputArgs, method) {
      method.apply(this, inputArgs.map(redactLogArgument) as never);
    },
  },
};

/**
 * Structured audit log (JSON lines) written to run.log. The human-readable
 * narrative shown in the terminal (checkmarks, "Explorer: ...", the final
 * summary block) is printed separately via plain console.log in index.ts;
 * this logger is the machine-readable trail, not the terminal UI.
 */
export function createLogger(logFilePath?: string): Logger {
  if (!logFilePath) {
    return pino(loggerOptions, pino.destination({ dest: 1, sync: false }));
  }

  return pino(
    loggerOptions,
    pino.destination({ dest: logFilePath, mkdir: true, sync: false })
  );
}
