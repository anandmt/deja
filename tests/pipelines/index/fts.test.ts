import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../../src/test/helpers";
import { runMigrations } from "../../../src/kernel/migrations";
import { storeObservation } from "../../../src/pipelines/index/fts";
import type { ExtractedObservation } from "../../../src/types";

function makeObs(overrides: Partial<ExtractedObservation> = {}): ExtractedObservation {
  return {
    kind: "file_edit",
    title: "Edited app.ts",
    content: "EDIT /project/src/app.ts\n--- old\nx\n+++ new\ny",
    facts: ["handleAuth"],
    concepts: ["auth", "handler"],
    files_read: [],
    files_modified: ["/project/src/app.ts"],
    ...overrides,
  };
}

describe("storeObservation", () => {
  let db: Database;

  afterEach(() => {
    if (db) cleanupDb(db);
  });

  test("inserts and returns id", () => {
    db = tmpDb();
    runMigrations(db);
    db.exec("INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/project', 1000)");
    const id = storeObservation(db, "s1", "/project", "medium", makeObs(), "{}", 1000);
    expect(id).toBe(1);
  });

  test("stored observation is retrievable", () => {
    db = tmpDb();
    runMigrations(db);
    db.exec("INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/project', 1000)");
    storeObservation(db, "s1", "/project", "high", makeObs({ title: "Created foo.ts" }), "{}", 2000);
    const row = db.query("SELECT title, significance, kind FROM observations WHERE id = 1").get() as any;
    expect(row.title).toBe("Created foo.ts");
    expect(row.significance).toBe("high");
    expect(row.kind).toBe("file_edit");
  });

  test("serializes JSON arrays for facts and concepts", () => {
    db = tmpDb();
    runMigrations(db);
    db.exec("INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/project', 1000)");
    storeObservation(db, "s1", "/project", "medium", makeObs({ facts: ["a", "b"], concepts: ["c"] }), "{}", 1000);
    const row = db.query("SELECT facts, concepts FROM observations WHERE id = 1").get() as any;
    expect(JSON.parse(row.facts)).toEqual(["a", "b"]);
    expect(JSON.parse(row.concepts)).toEqual(["c"]);
  });

  test("FTS trigger fires — observation is searchable", () => {
    db = tmpDb();
    runMigrations(db);
    db.exec("INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/project', 1000)");
    storeObservation(db, "s1", "/project", "medium", makeObs({ title: "Modified handleAuth()" }), "{}", 1000);
    const fts = db.query("SELECT * FROM observations_fts WHERE observations_fts MATCH 'handleAuth'").all();
    expect(fts.length).toBe(1);
  });

  test("multiple observations get sequential ids", () => {
    db = tmpDb();
    runMigrations(db);
    db.exec("INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/project', 1000)");
    const id1 = storeObservation(db, "s1", "/project", "medium", makeObs(), "{}", 1000);
    const id2 = storeObservation(db, "s1", "/project", "high", makeObs({ title: "Second" }), "{}", 2000);
    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });
});
