import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../src/test/helpers";
import { runMigrations } from "../../src/kernel/migrations";
import { generateContext } from "../../src/context/generator";
import { DEFAULT_SETTINGS } from "../../src/kernel/settings";

describe("generateContext (stub)", () => {
  let db: Database;

  afterEach(() => {
    if (db) cleanupDb(db);
  });

  test("returns empty string", () => {
    db = tmpDb();
    runMigrations(db);

    const result = generateContext(db, "/project", "session-1", DEFAULT_SETTINGS);
    expect(result).toBe("");
  });
});
