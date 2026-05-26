import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../src/test/helpers";
import { runMigrations } from "../../src/kernel/migrations";
import { getOverview, getRecentObservations, getSessions, getProjects } from "../../src/dashboard/api";

function insertSession(db: Database, id: string, project: string, summary: string | null = null, startedAt: number = Date.now()): void {
  db.prepare("INSERT INTO sessions (id, project, started_at_epoch, ended_at_epoch, summary) VALUES (?, ?, ?, ?, ?)")
    .run(id, project, startedAt, startedAt + 3600000, summary);
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

describe("getOverview", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns counts for a project", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    insertSession(db, "s2", "/project");
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "decision", title: "D1" });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: "E1" });
    insertObs(db, { sessionId: "s2", project: "/project", significance: "critical", kind: "decision", title: "D2" });

    const result = getOverview(db, "/project");
    expect(result.sessions).toBe(2);
    expect(result.observations).toBe(3);
    expect(result.by_significance.critical).toBe(1);
    expect(result.by_significance.high).toBe(1);
    expect(result.by_significance.medium).toBe(1);
  });

  test("returns zeros for empty project", () => {
    db = tmpDb();
    runMigrations(db);
    const result = getOverview(db, "/empty");
    expect(result.sessions).toBe(0);
    expect(result.observations).toBe(0);
  });
});

describe("getRecentObservations", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns observations ordered by recency", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "decision", title: "Old", createdAt: 1000 });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: "New", createdAt: 2000 });

    const results = getRecentObservations(db, "/project", 10);
    expect(results.length).toBe(2);
    expect(results[0].title).toBe("New");
    expect(results[1].title).toBe("Old");
  });

  test("respects limit", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    for (let i = 0; i < 20; i++) {
      insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: `Obs ${i}`, createdAt: i });
    }

    const results = getRecentObservations(db, "/project", 5);
    expect(results.length).toBe(5);
  });
});

describe("getSessions", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns sessions with observation counts", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", "Session one summary", 1000);
    insertSession(db, "s2", "/project", null, 2000);
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "decision", title: "D1" });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: "E1" });
    insertObs(db, { sessionId: "s2", project: "/project", significance: "low", kind: "file_read", title: "R1" });

    const results = getSessions(db, "/project", 10);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe("s2");
    expect(results[0].obs_count).toBe(1);
    expect(results[1].id).toBe("s1");
    expect(results[1].obs_count).toBe(2);
    expect(results[1].summary).toBe("Session one summary");
  });
});

describe("getProjects", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns all projects with session counts", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a");
    insertSession(db, "s2", "/project-a");
    insertSession(db, "s3", "/project-b");

    const results = getProjects(db);
    expect(results.length).toBe(2);
    const a = results.find((r: any) => r.project === "/project-a");
    const b = results.find((r: any) => r.project === "/project-b");
    expect(a!.session_count).toBe(2);
    expect(b!.session_count).toBe(1);
  });

  test("returns empty array for empty DB", () => {
    db = tmpDb();
    runMigrations(db);
    const results = getProjects(db);
    expect(results).toEqual([]);
  });
});
