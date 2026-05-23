import type { Database } from "bun:sqlite";

export const version = 1;

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      project           TEXT NOT NULL,
      started_at_epoch  INTEGER NOT NULL,
      ended_at_epoch    INTEGER,
      summary           TEXT,
      summary_embedding BLOB
    );

    CREATE TABLE IF NOT EXISTS observations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL REFERENCES sessions(id),
      project         TEXT NOT NULL,
      significance    TEXT NOT NULL DEFAULT 'medium',
      kind            TEXT NOT NULL,
      title           TEXT NOT NULL,
      content         TEXT NOT NULL,
      facts           TEXT,
      concepts        TEXT,
      files_read      TEXT,
      files_modified  TEXT,
      raw_event       TEXT NOT NULL,
      embedding       BLOB,
      created_at_epoch INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title, content, facts, concepts,
      content='observations',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, content, facts, concepts)
      VALUES (new.id, new.title, new.content, new.facts, new.concepts);
    END;

    CREATE TRIGGER IF NOT EXISTS obs_fts_update AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, facts, concepts)
      VALUES ('delete', old.id, old.title, old.content, old.facts, old.concepts);
      INSERT INTO observations_fts(rowid, title, content, facts, concepts)
      VALUES (new.id, new.title, new.content, new.facts, new.concepts);
    END;

    CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, facts, concepts)
      VALUES ('delete', old.id, old.title, old.content, old.facts, old.concepts);
    END;

    CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
    CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_obs_significance ON observations(significance);
    CREATE INDEX IF NOT EXISTS idx_obs_kind ON observations(kind);
    CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at_epoch);

    CREATE TABLE IF NOT EXISTS stats (
      project     TEXT NOT NULL,
      metric      TEXT NOT NULL,
      value       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project, metric)
    );
  `);
}
