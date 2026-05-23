import { Database } from "bun:sqlite";

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

export async function withRetry<T>(
  fn: () => T,
  maxRetries: number = 3,
  delayMs: number = 50
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      const isBusy =
        err instanceof Error &&
        ((err as any).code === "SQLITE_BUSY" ||
          err.message.includes("database is locked"));
      if (!isBusy || attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
  throw new Error("unreachable");
}
