import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../src/test/helpers";
import { runMigrations } from "../../src/kernel/migrations";
import { cliStats } from "../../src/cli/stats";

function insertSession(db: Database, id: string, project: string): void {
  db.prepare("INSERT INTO sessions (id, project, started_at_epoch, ended_at_epoch, summary) VALUES (?, ?, ?, ?, NULL)")
    .run(id, project, Date.now(), Date.now() + 3600000);
}

function insertObs(db: Database, opts: {
  sessionId: string; project: string; significance: string; kind: string;
  title: string;
}): void {
  db.prepare(
    `INSERT INTO observations (session_id, project, significance, kind, title, content, facts, concepts, files_read, files_modified, raw_event, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, 'content', '[]', '[]', '[]', '[]', '{}', ?)`
  ).run(opts.sessionId, opts.project, opts.significance, opts.kind, opts.title, Date.now());
}

describe("cliStats", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("shows observation and session counts", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    insertSession(db, "s2", "/project");
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "decision", title: "D1" });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: "E1" });
    insertObs(db, { sessionId: "s2", project: "/project", significance: "low", kind: "file_read", title: "R1" });

    const output = cliStats(db, "/project");
    expect(output).toContain("3");
    expect(output).toContain("2");
  });

  test("shows stats counters when present", () => {
    db = tmpDb();
    runMigrations(db);
    db.prepare("INSERT INTO stats (project, metric, value) VALUES (?, 'context_injections', 42)").run("/project");
    db.prepare("INSERT INTO stats (project, metric, value) VALUES (?, 'context_chars_total', 128000)").run("/project");

    const output = cliStats(db, "/project");
    expect(output).toContain("42");
    expect(output).toContain("128000");
  });

  test("shows zero counts for empty project", () => {
    db = tmpDb();
    runMigrations(db);
    const output = cliStats(db, "/project");
    expect(output).toContain("0");
  });

  test("shows breakdown by significance", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    insertObs(db, { sessionId: "s1", project: "/project", significance: "critical", kind: "decision", title: "C1" });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "critical", kind: "decision", title: "C2" });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "file_edit", title: "H1" });

    const output = cliStats(db, "/project");
    expect(output).toContain("critical");
    expect(output).toContain("high");
  });
});
