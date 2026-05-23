import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../src/test/helpers";
import { runMigrations } from "../../src/kernel/migrations";

describe("runMigrations", () => {
  let db: Database;

  afterEach(() => {
    if (db) cleanupDb(db);
  });

  test("creates schema_version table if not exists", () => {
    db = tmpDb();
    runMigrations(db);
    const rows = db.query("SELECT version FROM schema_version").all();
    expect(rows.length).toBeGreaterThan(0);
  });

  test("creates observations table with correct columns", () => {
    db = tmpDb();
    runMigrations(db);
    const info = db.query("PRAGMA table_info(observations)").all() as Array<{ name: string }>;
    const columns = info.map((c) => c.name);
    expect(columns).toContain("id");
    expect(columns).toContain("session_id");
    expect(columns).toContain("project");
    expect(columns).toContain("significance");
    expect(columns).toContain("kind");
    expect(columns).toContain("title");
    expect(columns).toContain("content");
    expect(columns).toContain("facts");
    expect(columns).toContain("concepts");
    expect(columns).toContain("files_read");
    expect(columns).toContain("files_modified");
    expect(columns).toContain("raw_event");
    expect(columns).toContain("embedding");
    expect(columns).toContain("created_at_epoch");
  });

  test("creates sessions table", () => {
    db = tmpDb();
    runMigrations(db);
    const info = db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const columns = info.map((c) => c.name);
    expect(columns).toContain("id");
    expect(columns).toContain("project");
    expect(columns).toContain("started_at_epoch");
    expect(columns).toContain("summary");
  });

  test("creates FTS5 virtual table", () => {
    db = tmpDb();
    runMigrations(db);
    const result = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
    ).get() as { name: string } | null;
    expect(result).not.toBeNull();
  });

  test("creates stats table", () => {
    db = tmpDb();
    runMigrations(db);
    const info = db.query("PRAGMA table_info(stats)").all() as Array<{ name: string }>;
    const columns = info.map((c) => c.name);
    expect(columns).toContain("project");
    expect(columns).toContain("metric");
    expect(columns).toContain("value");
  });

  test("FTS trigger inserts on observation insert", () => {
    db = tmpDb();
    runMigrations(db);
    db.exec(`INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/test', 1000)`);
    db.exec(`INSERT INTO observations (session_id, project, significance, kind, title, content, raw_event, created_at_epoch)
      VALUES ('s1', '/test', 'medium', 'file_edit', 'Modified foo()', 'Changed function foo', '{}', 1000)`);
    const fts = db.query(
      "SELECT * FROM observations_fts WHERE observations_fts MATCH 'foo'"
    ).all() as Array<{ title: string; content: string }>;
    expect(fts.length).toBe(1);
    expect(fts[0].title).toBe("Modified foo()");
    expect(fts[0].content).toBe("Changed function foo");
  });

  test("FTS trigger deletes on observation delete", () => {
    db = tmpDb();
    runMigrations(db);
    db.exec(`INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/test', 1000)`);
    db.exec(`INSERT INTO observations (session_id, project, significance, kind, title, content, raw_event, created_at_epoch)
      VALUES ('s1', '/test', 'medium', 'file_edit', 'Modified foo()', 'Changed function foo', '{}', 1000)`);
    db.exec(`DELETE FROM observations WHERE id = 1`);
    const fts = db.query(
      "SELECT * FROM observations_fts WHERE observations_fts MATCH 'foo'"
    ).all();
    expect(fts.length).toBe(0);
  });

  test("is idempotent — running twice does not error", () => {
    db = tmpDb();
    runMigrations(db);
    runMigrations(db);
    const rows = db.query("SELECT version FROM schema_version").all();
    expect(rows.length).toBe(1);
  });

  test("creates indexes", () => {
    db = tmpDb();
    runMigrations(db);
    const indexes = db.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_obs_%'"
    ).all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_obs_project");
    expect(names).toContain("idx_obs_session");
    expect(names).toContain("idx_obs_significance");
    expect(names).toContain("idx_obs_kind");
    expect(names).toContain("idx_obs_created");
  });
});
