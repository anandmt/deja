import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../src/test/helpers";
import { runMigrations } from "../../src/kernel/migrations";
import { Pipeline } from "../../src/worker/pipeline";
import { DEFAULT_SETTINGS } from "../../src/kernel/settings";
import type { HookPayload, BatchAnnotation } from "../../src/types";
import type { Logger } from "../../src/kernel/log";

const noop: Logger = (() => {}) as any;
noop.flush = () => {};

function defaultBatch(): BatchAnnotation {
  return { batch_size: 1, batch_index: 0, multi_file_edit: false, unique_files: [] };
}

function editPayload(overrides: Partial<HookPayload> = {}): HookPayload {
  return {
    type: "PostToolUse",
    session_id: "test-session",
    cwd: "/project",
    tool: "Edit",
    input: {
      file_path: "/project/src/app.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    },
    output: { success: true },
    ...overrides,
  } as HookPayload;
}

function writePayload(): HookPayload {
  return {
    type: "PostToolUse",
    session_id: "test-session",
    cwd: "/project",
    tool: "Write",
    input: {
      file_path: "/project/src/new-file.ts",
      content: "export class Foo {}",
    },
    output: { success: true },
  } as HookPayload;
}

function bashPayload(command: string, stdout: string = ""): HookPayload {
  return {
    type: "PostToolUse",
    session_id: "test-session",
    cwd: "/project",
    tool: "Bash",
    input: { command },
    output: { stdout, stderr: "", exit_code: 0 },
  } as HookPayload;
}

function promptPayload(prompt: string): HookPayload {
  return {
    type: "UserPromptSubmit",
    session_id: "test-session",
    cwd: "/project",
    prompt,
  } as HookPayload;
}

function readPayload(): HookPayload {
  return {
    type: "PostToolUse",
    session_id: "test-session",
    cwd: "/project",
    tool: "Read",
    input: { file_path: "/project/node_modules/foo/index.js" },
    output: { content: "module.exports = {}" },
  } as HookPayload;
}

describe("Pipeline", () => {
  let db: Database;

  afterEach(() => {
    if (db) cleanupDb(db);
  });

  test("processes Edit event into stored observation", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(editPayload(), defaultBatch());

    const obs = db.query("SELECT * FROM observations WHERE id = 1").get() as any;
    expect(obs).not.toBeNull();
    expect(obs.kind).toBe("file_edit");
    expect(obs.significance).toBe("medium");
    expect(obs.project).toBe("/project");
    expect(obs.session_id).toBe("test-session");
  });

  test("auto-creates session on first event", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(editPayload(), defaultBatch());

    const session = db.query("SELECT * FROM sessions WHERE id = 'test-session'").get() as any;
    expect(session).not.toBeNull();
    expect(session.project).toBe("/project");
  });

  test("does not duplicate session on second event", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(editPayload(), defaultBatch());
    pipeline.processEvent(editPayload(), defaultBatch());

    const count = db.query("SELECT COUNT(*) as c FROM sessions").get() as any;
    expect(count.c).toBe(1);
  });

  test("skips noise events (node_modules read)", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(readPayload(), defaultBatch());

    const count = db.query("SELECT COUNT(*) as c FROM observations").get() as any;
    expect(count.c).toBe(0);
  });

  test("increments events_skipped stat for skipped events", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(readPayload(), defaultBatch());

    const stat = db.query(
      "SELECT value FROM stats WHERE project = '/project' AND metric = 'events_skipped'"
    ).get() as any;
    expect(stat.value).toBe(1);
  });

  test("increments events_stored stat for stored events", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(editPayload(), defaultBatch());

    const stat = db.query(
      "SELECT value FROM stats WHERE project = '/project' AND metric = 'events_stored'"
    ).get() as any;
    expect(stat.value).toBe(1);
  });

  test("Write event classified as critical (new source file)", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(writePayload(), defaultBatch());

    const obs = db.query("SELECT * FROM observations WHERE id = 1").get() as any;
    expect(obs.significance).toBe("critical");
    expect(obs.kind).toBe("file_write");
  });

  test("tracks seenWritePaths — second write to same file is not critical", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(writePayload(), defaultBatch());
    pipeline.processEvent(writePayload(), defaultBatch());

    const rows = db.query("SELECT significance FROM observations ORDER BY id").all() as any[];
    expect(rows[0].significance).toBe("critical");
    expect(rows[1].significance).toBe("medium");
  });

  test("decision prompt classified as critical", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(
      promptPayload("let's use Redis for caching"),
      defaultBatch(),
    );

    const obs = db.query("SELECT * FROM observations WHERE id = 1").get() as any;
    expect(obs.significance).toBe("critical");
    expect(obs.kind).toBe("decision");
  });

  test("observation content is searchable via FTS", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(editPayload(), defaultBatch());

    const fts = db.query(
      "SELECT * FROM observations_fts WHERE observations_fts MATCH 'app'"
    ).all();
    expect(fts.length).toBe(1);
  });

  test("skips SessionStart lifecycle events", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(
      { type: "SessionStart", session_id: "s1", cwd: "/project" } as HookPayload,
      defaultBatch(),
    );

    const count = db.query("SELECT COUNT(*) as c FROM observations").get() as any;
    expect(count.c).toBe(0);
  });

  test("processes bash command into observation", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(
      bashPayload("npm run build", "Compiled successfully"),
      defaultBatch(),
    );

    const obs = db.query("SELECT * FROM observations WHERE id = 1").get() as any;
    expect(obs.kind).toBe("bash_cmd");
    expect(obs.title).toContain("npm run build");
  });
});
