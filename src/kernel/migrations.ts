import type { Database } from "bun:sqlite";
import { version as v1, up as up1 } from "./migrations/001_initial";

interface Migration {
  version: number;
  up: (db: Database) => void;
}

const migrations: Migration[] = [{ version: v1, up: up1 }];

export function runMigrations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const current = db
    .query("SELECT MAX(version) as v FROM schema_version")
    .get() as { v: number | null };
  const currentVersion = current?.v ?? 0;

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    db.transaction(() => {
      migration.up(db);
      db.exec(
        `INSERT INTO schema_version (version, applied_at) VALUES (${migration.version}, ${Date.now()})`
      );
    })();
  }
}
