import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../src/test/helpers";
import { runMigrations } from "../../src/kernel/migrations";
import {
  getLastSessionSummary,
  getTopObservations,
  getCrossProjectInsights,
} from "../../src/context/queries";

function insertSession(db: Database, id: string, project: string, summary: string | null, startedAt: number = Date.now()): void {
  db.prepare("INSERT INTO sessions (id, project, started_at_epoch, ended_at_epoch, summary) VALUES (?, ?, ?, ?, ?)").run(id, project, startedAt, startedAt + 3600000, summary);
}

function insertObs(db: Database, opts: {
  sessionId: string; project: string; significance: string; kind: string;
  title: string; content?: string; concepts?: string[]; createdAt?: number;
}): void {
  db.prepare(
    `INSERT INTO observations (session_id, project, significance, kind, title, content, facts, concepts, files_read, files_modified, raw_event, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, '[]', '[]', '{}', ?)`
  ).run(
    opts.sessionId, opts.project, opts.significance, opts.kind,
    opts.title, opts.content ?? "content",
    JSON.stringify(opts.concepts ?? []),
    opts.createdAt ?? Date.now(),
  );
}

describe("getLastSessionSummary", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns summary of most recent session for project", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", "First session summary", 1000);
    insertSession(db, "s2", "/project", "Second session summary", 2000);

    const result = getLastSessionSummary(db, "/project");
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Second session summary");
    expect(result!.started_at_epoch).toBe(2000);
  });

  test("returns null when no sessions exist", () => {
    db = tmpDb();
    runMigrations(db);
    const result = getLastSessionSummary(db, "/project");
    expect(result).toBeNull();
  });

  test("returns null when latest session has no summary", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", null, 1000);
    const result = getLastSessionSummary(db, "/project");
    expect(result).toBeNull();
  });

  test("ignores sessions from other projects", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/other", "Other project session", 2000);
    const result = getLastSessionSummary(db, "/project");
    expect(result).toBeNull();
  });
});

describe("getTopObservations", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns observations sorted by significance then recency", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", null);
    insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: "Medium edit", createdAt: 3000 });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "critical", kind: "decision", title: "Critical decision", createdAt: 1000 });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "file_write", title: "High write", createdAt: 2000 });

    const results = getTopObservations(db, "/project", 10);
    expect(results.length).toBe(3);
    expect(results[0].significance).toBe("critical");
    expect(results[1].significance).toBe("high");
    expect(results[2].significance).toBe("medium");
  });

  test("respects limit parameter", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", null);
    for (let i = 0; i < 15; i++) {
      insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: `Edit ${i}`, createdAt: i });
    }
    const results = getTopObservations(db, "/project", 5);
    expect(results.length).toBe(5);
  });

  test("excludes low significance observations", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", null);
    insertObs(db, { sessionId: "s1", project: "/project", significance: "low", kind: "file_read", title: "Low read" });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: "Medium edit" });

    const results = getTopObservations(db, "/project", 10);
    expect(results.length).toBe(1);
    expect(results[0].significance).toBe("medium");
  });

  test("returns empty array when no observations", () => {
    db = tmpDb();
    runMigrations(db);
    const results = getTopObservations(db, "/project", 10);
    expect(results).toEqual([]);
  });
});

describe("getCrossProjectInsights", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("finds observations from other projects with 2+ shared concepts", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a", null);
    insertSession(db, "s2", "/project-b", null);

    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Local obs", concepts: ["rate-limiting", "api", "caching"] });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "critical", kind: "decision", title: "Cross insight", concepts: ["rate-limiting", "api", "throttle"] });

    const results = getCrossProjectInsights(db, "/project-a", 2);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Cross insight");
    expect(results[0].project).toBe("/project-b");
    expect(results[0].shared_concepts).toBeGreaterThanOrEqual(2);
  });

  test("requires at least 2 shared concepts", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a", null);
    insertSession(db, "s2", "/project-b", null);

    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Local obs", concepts: ["rate-limiting", "api"] });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "high", kind: "file_edit", title: "Only 1 shared", concepts: ["rate-limiting", "unrelated"] });

    const results = getCrossProjectInsights(db, "/project-a", 2);
    expect(results.length).toBe(0);
  });

  test("only returns high/critical observations from other projects", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a", null);
    insertSession(db, "s2", "/project-b", null);

    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Local", concepts: ["api", "caching"] });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "medium", kind: "file_edit", title: "Medium cross", concepts: ["api", "caching"] });

    const results = getCrossProjectInsights(db, "/project-a", 2);
    expect(results.length).toBe(0);
  });

  test("returns empty when no other projects exist", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a", null);
    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Only local", concepts: ["api", "caching"] });

    const results = getCrossProjectInsights(db, "/project-a", 2);
    expect(results).toEqual([]);
  });

  test("respects max limit", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a", null);
    insertSession(db, "s2", "/project-b", null);

    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Local", concepts: ["api", "caching", "auth"] });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "critical", kind: "decision", title: "Cross 1", concepts: ["api", "caching"], createdAt: 2000 });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "high", kind: "file_edit", title: "Cross 2", concepts: ["api", "auth"], createdAt: 3000 });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "high", kind: "file_edit", title: "Cross 3", concepts: ["caching", "auth"], createdAt: 4000 });

    const results = getCrossProjectInsights(db, "/project-a", 2);
    expect(results.length).toBe(2);
  });
});
