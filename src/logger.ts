import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(logFilePath?: string): Logger {
  const targets: pino.TransportTargetOptions[] = [
    {
      target: "pino-pretty",
      level: "info",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  ];

  if (logFilePath) {
    targets.push({
      target: "pino/file",
      level: "debug",
      options: { destination: logFilePath, mkdir: true },
    });
  }

  return pino({
    level: "debug",
    transport: { targets },
  });
}
