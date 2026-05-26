import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../src/test/helpers";
import { runMigrations } from "../../src/kernel/migrations";
import { generateContext } from "../../src/context/generator";
import { DEFAULT_SETTINGS } from "../../src/kernel/settings";
import type { Settings } from "../../src/types";

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

describe("generateContext", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns status line on empty database (first session)", () => {
    db = tmpDb();
    runMigrations(db);
    const result = generateContext(db, "/project", "s1", DEFAULT_SETTINGS);
    expect(result).toContain("First session");
    expect(result).toContain("Dashboard: http://localhost:19533");
    expect(result).toContain("system-reminder");
  });

  test("includes last session summary", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s-old", "/project", "Built the auth system", 1000);

    const result = generateContext(db, "/project", "s-new", DEFAULT_SETTINGS);
    expect(result).toContain("## Last session");
    expect(result).toContain("Built the auth system");
    expect(result).toContain("<system-reminder>");
  });

  test("includes high-significance observations", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", null);
    insertObs(db, { sessionId: "s1", project: "/project", significance: "critical", kind: "decision", title: "Chose Redis for caching" });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "file_write", title: "Created auth middleware" });

    const result = generateContext(db, "/project", "s-new", DEFAULT_SETTINGS);
    expect(result).toContain("CRITICAL: Chose Redis for caching");
    expect(result).toContain("HIGH: Created auth middleware");
  });

  test("includes cross-project insights when enabled", () => {
    db = tmpDb();
    runMigrations(db);
    const settings: Settings = { ...DEFAULT_SETTINGS, cross_project: true };
    insertSession(db, "s1", "/project-a", null);
    insertSession(db, "s2", "/project-b", null);
    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Local A", concepts: ["api", "caching", "rate-limiting"] });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "critical", kind: "decision", title: "Cross B insight", concepts: ["api", "caching"] });

    const result = generateContext(db, "/project-a", "s-new", settings);
    expect(result).toContain("Cross-project");
    expect(result).toContain("Cross B insight");
  });

  test("excludes cross-project when disabled", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a", null);
    insertSession(db, "s2", "/project-b", null);
    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Local A", concepts: ["api", "caching"] });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "critical", kind: "decision", title: "Cross B", concepts: ["api", "caching"] });

    const result = generateContext(db, "/project-a", "s-new", DEFAULT_SETTINGS);
    expect(result).not.toContain("Cross-project");
  });

  test("respects context_budget setting", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", "A very long session summary");
    for (let i = 0; i < 50; i++) {
      insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "file_edit", title: `Observation number ${i} with some padding text` });
    }

    const settings: Settings = { ...DEFAULT_SETTINGS, context_budget: 500 };
    const result = generateContext(db, "/project", "s-new", settings);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  test("includes footer about MCP tools", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", "Session summary");

    const result = generateContext(db, "/project", "s-new", DEFAULT_SETTINGS);
    expect(result).toContain("deja_search/deja_timeline/deja_observe");
  });

  test("increments stats counters", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", "Summary");

    generateContext(db, "/project", "s-new", DEFAULT_SETTINGS);

    const injections = db.query("SELECT value FROM stats WHERE project = '/project' AND metric = 'context_injections'").get() as any;
    expect(injections.value).toBe(1);

    const chars = db.query("SELECT value FROM stats WHERE project = '/project' AND metric = 'context_chars_total'").get() as any;
    expect(chars.value).toBeGreaterThan(0);
  });

  test("unused session budget rolls to observations", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", null);
    for (let i = 0; i < 30; i++) {
      insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "file_edit", title: `Observation ${i} with some extra text to fill space` });
    }

    const result = generateContext(db, "/project", "s-new", DEFAULT_SETTINGS);
    expect(result).toContain("## Key observations");
    expect(result).toContain("Observation");
  });
});
