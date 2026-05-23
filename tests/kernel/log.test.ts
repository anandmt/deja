import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createLogger, rotateOldLogs } from "../../src/kernel/log";


describe("createLogger", () => {
  let logsDir: string;

  beforeEach(() => {
    logsDir = mkdtempSync(join(tmpdir(), "deja-logs-"));
  });

  afterEach(() => {
    rmSync(logsDir, { recursive: true, force: true });
  });

  test("log writes to daily log file", () => {
    const logger = createLogger("debug", logsDir);
    logger("info", "test", "hello world");
    logger.flush();
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(logsDir, `deja-${today}.log`);
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain("[test]");
    expect(content).toContain("hello world");
    expect(content).toContain("INFO");
  });

  test("log respects level filtering — warn level skips info", () => {
    const logger = createLogger("warn", logsDir);
    logger("info", "test", "should not appear");
    logger("warn", "test", "should appear");
    logger.flush();
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(logsDir, `deja-${today}.log`);
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8");
    expect(content).not.toContain("should not appear");
    expect(content).toContain("should appear");
  });

  test("log respects level filtering — error always logs", () => {
    const logger = createLogger("error", logsDir);
    logger("error", "db", "corruption detected");
    logger.flush();
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(logsDir, `deja-${today}.log`);
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain("corruption detected");
  });

  test("log format matches spec: YYYY-MM-DDTHH:MM:SS.sss LEVEL [component] message", () => {
    const logger = createLogger("debug", logsDir);
    logger("warn", "socket", "connection refused");
    logger.flush();
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(logsDir, `deja-${today}.log`);
    const content = readFileSync(logFile, "utf-8").trim();
    const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\s+WARN\s+\[socket\]\s+connection refused$/;
    expect(pattern.test(content)).toBe(true);
  });
});

describe("rotateOldLogs", () => {
  let logsDir: string;

  beforeEach(() => {
    logsDir = mkdtempSync(join(tmpdir(), "deja-logs-"));
  });

  afterEach(() => {
    rmSync(logsDir, { recursive: true, force: true });
  });

  test("deletes log files older than maxDays", () => {
    const oldDate = new Date(Date.now() - 40 * 86400_000)
      .toISOString()
      .slice(0, 10);
    const recentDate = new Date().toISOString().slice(0, 10);
    writeFileSync(join(logsDir, `deja-${oldDate}.log`), "old log");
    writeFileSync(join(logsDir, `deja-${recentDate}.log`), "recent log");
    rotateOldLogs(logsDir, 30);
    expect(existsSync(join(logsDir, `deja-${oldDate}.log`))).toBe(false);
    expect(existsSync(join(logsDir, `deja-${recentDate}.log`))).toBe(true);
  });

  test("ignores non-log files", () => {
    writeFileSync(join(logsDir, "readme.txt"), "not a log");
    rotateOldLogs(logsDir, 30);
    expect(existsSync(join(logsDir, "readme.txt"))).toBe(true);
  });
});
