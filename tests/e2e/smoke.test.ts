import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../src/test/helpers";
import { runMigrations } from "../../src/kernel/migrations";
import { Pipeline } from "../../src/worker/pipeline";
import { DEFAULT_SETTINGS } from "../../src/kernel/settings";
import { generateContext } from "../../src/context/generator";
import { searchFts } from "../../src/pipelines/search/fts";
import { handleSearch, handleTimeline, handleObserve } from "../../src/mcp/tools";
import type { HookPayload, BatchAnnotation, Settings } from "../../src/types";
import type { Logger } from "../../src/kernel/log";

const noop: Logger = (() => {}) as any;
noop.flush = () => {};

function batch(): BatchAnnotation {
  return { batch_size: 1, batch_index: 0, multi_file_edit: false, unique_files: [] };
}

describe("end-to-end smoke test", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("full chain: pipeline → store → FTS → context injection → MCP tools", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    // 1. SessionStart creates session
    pipeline.processEvent(
      { type: "SessionStart", session_id: "smoke-session", cwd: "/smoke-project" } as HookPayload,
      batch(),
    );

    const session = db.query("SELECT * FROM sessions WHERE id = 'smoke-session'").get() as any;
    expect(session).not.toBeNull();
    expect(session.project).toBe("/smoke-project");

    // 2. PostToolUse events create observations
    pipeline.processEvent({
      type: "PostToolUse", session_id: "smoke-session", cwd: "/smoke-project",
      tool: "Write", input: { file_path: "/smoke-project/src/auth.ts", content: "export class Auth {}" },
      output: { success: true },
    } as HookPayload, batch());

    pipeline.processEvent({
      type: "PostToolUse", session_id: "smoke-session", cwd: "/smoke-project",
      tool: "Edit", input: { file_path: "/smoke-project/src/auth.ts", old_string: "class Auth", new_string: "class AuthService" },
      output: { success: true },
    } as HookPayload, batch());

    pipeline.processEvent({
      type: "PostToolUse", session_id: "smoke-session", cwd: "/smoke-project",
      tool: "Bash", input: { command: "bun test" },
      output: { stdout: "3 pass\n0 fail", stderr: "", exit_code: 0 },
    } as HookPayload, batch());

    const obsCount = (db.query("SELECT COUNT(*) as c FROM observations WHERE session_id = 'smoke-session'").get() as any).c;
    expect(obsCount).toBe(3);

    // 3. Stop closes session with summary
    pipeline.processEvent(
      { type: "Stop", session_id: "smoke-session", cwd: "/smoke-project" } as HookPayload,
      batch(),
    );

    const closedSession = db.query("SELECT * FROM sessions WHERE id = 'smoke-session'").get() as any;
    expect(closedSession.ended_at_epoch).not.toBeNull();
    expect(closedSession.summary).not.toBeNull();
    expect(closedSession.summary.length).toBeGreaterThan(0);

    // 4. Context injection works for a new session
    const context = generateContext(db, "/smoke-project", "new-session", DEFAULT_SETTINGS);
    expect(context).toContain("system-reminder");
    expect(context).toContain("Last session");
    expect(context).toContain(closedSession.summary.slice(0, 20));

    // 5. FTS search works
    const ftsResults = searchFts(db, "auth", { project: "/smoke-project" });
    expect(ftsResults.total_count).toBeGreaterThan(0);

    // 6. MCP tools work
    const searchResult = handleSearch(db, { query: "auth", project: "/smoke-project" });
    expect(searchResult.isError).toBeUndefined();
    const searchParsed = JSON.parse((searchResult.content[0] as any).text);
    expect(searchParsed.results.length).toBeGreaterThan(0);

    const obsId = searchParsed.results[0].id;

    const timelineResult = handleTimeline(db, { anchor: obsId });
    expect(timelineResult.isError).toBeUndefined();
    const timelineParsed = JSON.parse((timelineResult.content[0] as any).text);
    expect(timelineParsed.length).toBeGreaterThan(0);

    const observeResult = handleObserve(db, { ids: [obsId] });
    expect(observeResult.isError).toBeUndefined();
    const observeParsed = JSON.parse((observeResult.content[0] as any).text);
    expect(observeParsed.length).toBe(1);
    expect(observeParsed[0].id).toBe(obsId);
  });

  test("context injection includes high-significance observations", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    pipeline.processEvent(
      { type: "SessionStart", session_id: "s1", cwd: "/project" } as HookPayload,
      batch(),
    );

    pipeline.processEvent({
      type: "UserPromptSubmit", session_id: "s1", cwd: "/project",
      prompt: "let's use PostgreSQL for the database",
    } as HookPayload, batch());

    pipeline.processEvent(
      { type: "Stop", session_id: "s1", cwd: "/project" } as HookPayload,
      batch(),
    );

    const context = generateContext(db, "/project", "s2", DEFAULT_SETTINGS);
    expect(context).toContain("CRITICAL");
    expect(context).toContain("PostgreSQL");
  });

  test("cross-project insights work end-to-end", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    // Project A — file edits produce concepts from paths
    pipeline.processEvent(
      { type: "SessionStart", session_id: "sa", cwd: "/project-a" } as HookPayload,
      batch(),
    );
    pipeline.processEvent({
      type: "PostToolUse", session_id: "sa", cwd: "/project-a",
      tool: "Write", input: { file_path: "/project-a/src/api/cache/redis.ts", content: "export class RedisCache {}" },
      output: { success: true },
    } as HookPayload, batch());
    pipeline.processEvent(
      { type: "Stop", session_id: "sa", cwd: "/project-a" } as HookPayload,
      batch(),
    );

    // Project B — overlapping path concepts (api, cache)
    pipeline.processEvent(
      { type: "SessionStart", session_id: "sb", cwd: "/project-b" } as HookPayload,
      batch(),
    );
    pipeline.processEvent({
      type: "PostToolUse", session_id: "sb", cwd: "/project-b",
      tool: "Write", input: { file_path: "/project-b/src/api/cache/memcached.ts", content: "export class MemcachedCache {}" },
      output: { success: true },
    } as HookPayload, batch());
    pipeline.processEvent(
      { type: "Stop", session_id: "sb", cwd: "/project-b" } as HookPayload,
      batch(),
    );

    const settings: Settings = { ...DEFAULT_SETTINGS, cross_project: true };
    const context = generateContext(db, "/project-a", "sa2", settings);
    expect(context).toContain("Cross-project");
  });
});
