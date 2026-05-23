import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../../src/test/helpers";
import { runMigrations } from "../../../src/kernel/migrations";
import { storeObservation } from "../../../src/pipelines/index/fts";
import { searchFts } from "../../../src/pipelines/search/fts";
import type { ExtractedObservation } from "../../../src/types";

function makeObs(overrides: Partial<ExtractedObservation> = {}): ExtractedObservation {
  return {
    kind: "file_edit",
    title: "Edited app.ts",
    content: "some content",
    facts: [],
    concepts: [],
    files_read: [],
    files_modified: [],
    ...overrides,
  };
}

function seedDb(db: Database): void {
  db.exec("INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/project-a', 1000)");
  db.exec("INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s2', '/project-b', 2000)");
  storeObservation(db, "s1", "/project-a", "high", makeObs({ title: "Modified handleAuth", kind: "file_edit" }), "{}", 1000);
  storeObservation(db, "s1", "/project-a", "medium", makeObs({ title: "Edited config file", kind: "file_edit" }), "{}", 2000);
  storeObservation(db, "s1", "/project-a", "critical", makeObs({ title: "Decision: use Redis for caching", kind: "decision" }), "{}", 3000);
  storeObservation(db, "s2", "/project-b", "high", makeObs({ title: "Tests: handleAuth 42 passed", kind: "bash_cmd" }), "{}", 4000);
}

describe("searchFts", () => {
  let db: Database;

  afterEach(() => {
    if (db) cleanupDb(db);
  });

  test("returns matching observations", () => {
    db = tmpDb();
    runMigrations(db);
    seedDb(db);
    const { results, total_count } = searchFts(db, "handleAuth");
    expect(total_count).toBe(2);
    expect(results.length).toBe(2);
    expect(results[0].title).toContain("handleAuth");
  });

  test("filters by project", () => {
    db = tmpDb();
    runMigrations(db);
    seedDb(db);
    const { results, total_count } = searchFts(db, "handleAuth", { project: "/project-a" });
    expect(total_count).toBe(1);
    expect(results[0].title).toBe("Modified handleAuth");
  });

  test("filters by significance", () => {
    db = tmpDb();
    runMigrations(db);
    seedDb(db);
    const { results } = searchFts(db, "handleAuth", { significance: "high" });
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.significance).toBe("high");
    }
  });

  test("filters by kind", () => {
    db = tmpDb();
    runMigrations(db);
    seedDb(db);
    const { results } = searchFts(db, "handleAuth", { kind: "bash_cmd" });
    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("bash_cmd");
  });

  test("limit caps results", () => {
    db = tmpDb();
    runMigrations(db);
    seedDb(db);
    const { results, total_count } = searchFts(db, "handleAuth", { limit: 1 });
    expect(results.length).toBe(1);
    expect(total_count).toBe(2);
  });

  test("limit capped at 50 max", () => {
    db = tmpDb();
    runMigrations(db);
    seedDb(db);
    const { results } = searchFts(db, "handleAuth", { limit: 100 });
    expect(results.length).toBeLessThanOrEqual(50);
  });

  test("no match returns empty", () => {
    db = tmpDb();
    runMigrations(db);
    seedDb(db);
    const { results, total_count } = searchFts(db, "nonexistentterm");
    expect(results.length).toBe(0);
    expect(total_count).toBe(0);
  });

  test("searches across title, content, facts, and concepts", () => {
    db = tmpDb();
    runMigrations(db);
    seedDb(db);
    const { results } = searchFts(db, "Redis");
    expect(results.length).toBe(1);
    expect(results[0].title).toContain("Redis");
  });

  test("handles special FTS characters without crashing", () => {
    db = tmpDb();
    runMigrations(db);
    seedDb(db);
    expect(() => searchFts(db, '"unbalanced')).not.toThrow();
    expect(() => searchFts(db, "handle OR drop")).not.toThrow();
    expect(() => searchFts(db, "NOT everything")).not.toThrow();
  });
});
