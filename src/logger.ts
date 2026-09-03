import pino from "pino";

export type Logger = pino.Logger;

/**
 * Structured audit log (JSON lines) written to run.log. The human-readable
 * narrative shown in the terminal (checkmarks, "Explorer: ...", the final
 * summary block) is printed separately via plain console.log in index.ts;
 * this logger is the machine-readable trail, not the terminal UI.
 */
export function createLogger(logFilePath?: string): Logger {
  if (!logFilePath) {
    return pino({ level: "debug" }, pino.destination({ dest: 1, sync: false }));
  }

  return pino(
    { level: "debug" },
    pino.destination({ dest: logFilePath, mkdir: true, sync: false })
  );
}
