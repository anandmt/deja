import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../src/test/helpers";
import { runMigrations } from "../../src/kernel/migrations";
import { handleSearch, handleTimeline, handleObserve } from "../../src/mcp/tools";

function insertSession(db: Database, id: string, project: string): void {
  db.prepare("INSERT INTO sessions (id, project, started_at_epoch, ended_at_epoch, summary) VALUES (?, ?, ?, ?, NULL)")
    .run(id, project, Date.now(), Date.now() + 3600000);
}

function insertObs(db: Database, opts: {
  sessionId: string; project: string; significance: string; kind: string;
  title: string; content?: string; concepts?: string[]; createdAt?: number;
}): number {
  db.prepare(
    `INSERT INTO observations (session_id, project, significance, kind, title, content, facts, concepts, files_read, files_modified, raw_event, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, '[]', '[]', '{}', ?)`
  ).run(
    opts.sessionId, opts.project, opts.significance, opts.kind,
    opts.title, opts.content ?? "some content",
    JSON.stringify(opts.concepts ?? []),
    opts.createdAt ?? Date.now(),
  );
  return (db.query("SELECT last_insert_rowid() as id").get() as any).id;
}

describe("handleSearch", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns matching observations via FTS", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "decision", title: "Chose Redis for caching" });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: "Updated package.json" });

    const result = handleSearch(db, { query: "Redis", project: "/project" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results.length).toBe(1);
    expect(parsed.results[0].title).toContain("Redis");
    expect(parsed.total_count).toBe(1);
  });

  test("filters by significance", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    insertObs(db, { sessionId: "s1", project: "/project", significance: "critical", kind: "decision", title: "Critical thing about auth" });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "low", kind: "file_read", title: "Read auth file" });

    const result = handleSearch(db, { query: "auth", project: "/project", significance: "critical" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results.length).toBe(1);
    expect(parsed.results[0].significance).toBe("critical");
  });

  test("filters by kind", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "decision", title: "Decided on REST api" });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "file_edit", title: "Edited api route" });

    const result = handleSearch(db, { query: "api", project: "/project", kind: "decision" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results.length).toBe(1);
    expect(parsed.results[0].kind).toBe("decision");
  });

  test("respects limit parameter", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    for (let i = 0; i < 10; i++) {
      insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: `Edit number ${i} of config` });
    }

    const result = handleSearch(db, { query: "config", project: "/project", limit: 3 });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results.length).toBe(3);
    expect(parsed.total_count).toBe(10);
  });

  test("returns empty results for no matches", () => {
    db = tmpDb();
    runMigrations(db);
    const result = handleSearch(db, { query: "nonexistent", project: "/project" });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.results).toEqual([]);
    expect(parsed.total_count).toBe(0);
  });
});

describe("handleTimeline", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns observations around anchor in same session", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_read", title: "Read config", createdAt: 1000 });
    const id2 = insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "decision", title: "Chose approach", createdAt: 2000 });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: "Implemented approach", createdAt: 3000 });

    const result = handleTimeline(db, { anchor: id2 });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.length).toBe(3);
    expect(parsed[0].title).toBe("Read config");
    expect(parsed[1].title).toBe("Chose approach");
    expect(parsed[2].title).toBe("Implemented approach");
  });

  test("excludes observations from different sessions", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    insertSession(db, "s2", "/project");
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "decision", title: "Session 1 obs", createdAt: 1000 });
    const anchor = insertObs(db, { sessionId: "s2", project: "/project", significance: "high", kind: "decision", title: "Session 2 obs", createdAt: 2000 });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "decision", title: "Another s1 obs", createdAt: 3000 });

    const result = handleTimeline(db, { anchor });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.length).toBe(1);
    expect(parsed[0].title).toBe("Session 2 obs");
  });

  test("returns error for non-existent anchor", () => {
    db = tmpDb();
    runMigrations(db);
    const result = handleTimeline(db, { anchor: 99999 });
    expect(result.isError).toBe(true);
  });

  test("limits context window with depth_before and depth_after", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    for (let i = 0; i < 10; i++) {
      insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: `Step ${i}`, createdAt: i * 1000 });
    }
    const rows = db.prepare("SELECT id FROM observations ORDER BY created_at_epoch").all() as { id: number }[];
    const anchorId = rows[5].id;

    const result = handleTimeline(db, { anchor: anchorId, depth_before: 2, depth_after: 2 });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.length).toBe(5);
  });
});

describe("handleObserve", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns full observation details for given IDs", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project");
    const id1 = insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "decision", title: "Chose Redis", content: "We chose Redis because..." });
    const id2 = insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: "Updated config", content: "Changed port to 6379" });

    const result = handleObserve(db, { ids: [id1, id2] });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.length).toBe(2);
    expect(parsed[0].content).toBe("We chose Redis because...");
    expect(parsed[1].content).toBe("Changed port to 6379");
  });

  test("enforces max 10 IDs cap", () => {
    db = tmpDb();
    runMigrations(db);
    const ids = Array.from({ length: 15 }, (_, i) => i + 1);
    const result = handleObserve(db, { ids });
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("10");
  });

  test("returns empty array for non-existent IDs", () => {
    db = tmpDb();
    runMigrations(db);
    const result = handleObserve(db, { ids: [99999] });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed).toEqual([]);
  });

  test("returns error for empty IDs array", () => {
    db = tmpDb();
    runMigrations(db);
    const result = handleObserve(db, { ids: [] });
    expect(result.isError).toBe(true);
  });
});
