import { describe, test, expect, afterEach } from "bun:test";
import { tmpDir, cleanupDb } from "../../src/test/helpers";
import { openDb, withRetry } from "../../src/kernel/db";
import { Database } from "bun:sqlite";

describe("openDb", () => {
  let db: Database;

  afterEach(() => {
    if (db) cleanupDb(db);
  });

  test("creates database with WAL journal mode", () => {
    const dir = tmpDir();
    db = openDb(`${dir}/wal-test.db`);
    const result = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
  });

  test("sets busy_timeout to 5000ms", () => {
    const dir = tmpDir();
    db = openDb(`${dir}/timeout-test.db`);
    const result = db.query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(result.timeout).toBe(5000);
  });

  test("creates database file if it does not exist", () => {
    const dir = tmpDir();
    const dbPath = `${dir}/new.db`;
    db = openDb(dbPath);
    expect(db.filename).toBe(dbPath);
  });
});

describe("withRetry", () => {
  test("returns result on first success", async () => {
    const result = await withRetry(() => 42, 3, 10);
    expect(result).toBe(42);
  });

  test("retries on SQLITE_BUSY and succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(() => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("database is locked");
        (err as any).code = "SQLITE_BUSY";
        throw err;
      }
      return "ok";
    }, 3, 10);
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("throws after max retries exhausted", async () => {
    const busyErr = new Error("database is locked");
    (busyErr as any).code = "SQLITE_BUSY";
    await expect(
      withRetry(() => { throw busyErr; }, 3, 10)
    ).rejects.toThrow("database is locked");
  });

  test("does not retry non-BUSY errors", async () => {
    let attempts = 0;
    await expect(
      withRetry(() => {
        attempts++;
        throw new Error("syntax error");
      }, 3, 10)
    ).rejects.toThrow("syntax error");
    expect(attempts).toBe(1);
  });
});
