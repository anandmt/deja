import {
  appendFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  existsSync,
} from "fs";
import { join } from "path";
import type { LogLevel } from "../types";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  error: "ERROR",
  warn: "WARN ",
  info: "INFO ",
  debug: "DEBUG",
};

export interface Logger {
  (level: LogLevel, component: string, message: string): void;
  flush(): void;
}

export function createLogger(minLevel: LogLevel, logsDir: string): Logger {
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  const minPriority = LEVEL_PRIORITY[minLevel];
  let buffer: string[] = [];

  function getLogPath(): string {
    const today = new Date().toISOString().slice(0, 10);
    return join(logsDir, `deja-${today}.log`);
  }

  const logger: Logger = (
    level: LogLevel,
    component: string,
    message: string
  ) => {
    if (LEVEL_PRIORITY[level] > minPriority) return;

    const now = new Date().toISOString().replace("Z", "").slice(0, 23);
    const line = `${now} ${LEVEL_LABEL[level]} [${component}] ${message}\n`;
    buffer.push(line);

    if (buffer.length >= 10 || level === "error") {
      logger.flush();
    }
  };

  logger.flush = () => {
    if (buffer.length === 0) return;
    const logPath = getLogPath();
    appendFileSync(logPath, buffer.join(""));
    buffer = [];
  };

  return logger;
}

export function rotateOldLogs(logsDir: string, maxDays: number): void {
  if (!existsSync(logsDir)) return;

  const cutoff = Date.now() - maxDays * 86400_000;
  const pattern = /^deja-(\d{4}-\d{2}-\d{2})\.log$/;

  for (const file of readdirSync(logsDir)) {
    const match = file.match(pattern);
    if (!match) continue;
    const fileDate = new Date(match[1]).getTime();
    if (fileDate < cutoff) {
      unlinkSync(join(logsDir, file));
    }
  }
}
