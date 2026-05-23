import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "deja-test-"));
}

export function tmpDb(): Database {
  const dir = tmpDir();
  const dbPath = join(dir, "test.db");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  return db;
}

export function cleanupDb(db: Database): void {
  const filename = db.filename;
  db.close();
  if (filename) {
    const dir = join(filename, "..");
    rmSync(dir, { recursive: true, force: true });
  }
}
