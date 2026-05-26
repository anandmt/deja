import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../src/test/helpers";
import { runMigrations } from "../../src/kernel/migrations";
import { cliSearch } from "../../src/cli/search";

function insertSession(db: Database, id: string, project: string): void {
  db.prepare("INSERT INTO sessions (id, project, started_at_epoch, ended_at_epoch, summary) VALUES (?, ?, ?, ?, NULL)")
    .run(id, project, Date.now(), Date.now() + 3600000);
}

function insertObs(db: Database, opts: {
  sessionId: string; project: string; significance: string; kind: string;
  title: string; createdAt?: number;
}): void {
  db.prepare(
    `INSERT INTO observations (session_id, project, significance, kind, title, content, facts, concepts, files_read, files_modified, raw_event, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, 'content', '[]', '[]', '[]', '[]', '{}', ?)`
  ).run(opts.sessionId, opts.project, opts.significance, opts.kind, opts.title, opts.createdAt ?? Date.now());
}

describe("cliSearch", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns formatted search results", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "decision", title: "Chose Redis for caching" });

    const output = cliSearch(db, "Redis", {});
    expect(output).toContain("Redis");
    expect(output).toContain("1 result");
  });

  test("shows no results message", () => {
    db = tmpDb();
    runMigrations(db);
    const output = cliSearch(db, "nonexistent", {});
    expect(output).toContain("No results");
  });

  test("filters by project", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a");
    insertSession(db, "s2", "/project-b");
    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "high", kind: "decision", title: "Auth in project A" });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "high", kind: "decision", title: "Auth in project B" });

    const output = cliSearch(db, "Auth", { project: "/project-a" });
    expect(output).toContain("1 result");
  });

  test("shows total count when more results exist", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    for (let i = 0; i < 10; i++) {
      insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: `Edit config file ${i}` });
    }

    const output = cliSearch(db, "config", { limit: 3 });
    expect(output).toContain("3 of 10");
  });
});
