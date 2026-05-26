import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from "fs";
import { acquireLock, releaseLock } from "./lock";
import type { Logger } from "./log";

const WAL_WARN_BYTES = 8 * 1024 * 1024;
const WAL_MAX_BYTES = 10 * 1024 * 1024;

export function appendToWal(
  walPath: string,
  lockPath: string,
  event: string,
  log?: Logger,
): void {
  const fd = acquireLock(lockPath);
  try {
    const size = walSize(walPath);
    if (size >= WAL_MAX_BYTES) {
      log?.("warn", "wal", `WAL at ${size} bytes — dropping event (worker may be down)`);
      return;
    }
    if (size >= WAL_WARN_BYTES) {
      log?.("warn", "wal", `WAL approaching limit: ${size} bytes`);
    }
    appendFileSync(walPath, event + "\n");
  } finally {
    releaseLock(fd);
  }
}

export function drainWal(
  walPath: string,
  lockPath: string,
  log?: Logger,
): string[] {
  if (!existsSync(walPath)) return [];

  const fd = acquireLock(lockPath);
  try {
    const raw = readFileSync(walPath, "utf-8");
    if (!raw.trim()) return [];

    writeFileSync(walPath, "");

    const lines = raw.split("\n").filter((l) => l.trim());
    const events: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        JSON.parse(lines[i]);
        events.push(lines[i]);
      } catch {
        if (i === lines.length - 1) {
          log?.("warn", "wal", "Skipped incomplete last line in WAL");
        } else {
          log?.("warn", "wal", `Skipped malformed line ${i} in WAL`);
        }
      }
    }

    return events;
  } finally {
    releaseLock(fd);
  }
}

export function walSize(walPath: string): number {
  try {
    return statSync(walPath).size;
  } catch {
    return 0;
  }
}
