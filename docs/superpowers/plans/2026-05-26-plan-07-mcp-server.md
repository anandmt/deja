# Plan 7: MCP Server — deja_search, deja_timeline, deja_observe

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MCP stdio server that exposes the 3-layer protocol (search → timeline → observe) as Claude Code tools. After this plan, Claude can search observations by keyword, browse chronological context, and fetch full observation details — all through the MCP server process that reads the DB directly (read-only).

**Architecture:** A thin `McpServer` from `@modelcontextprotocol/sdk` registers three tools. Each tool delegates to a pure query function. The server entry point (`src/mcp/server.ts`) wires up stdio transport. Tool handlers live in `src/mcp/tools.ts` as pure functions that take a `Database` and return `CallToolResult`. This keeps tool logic unit-testable without MCP protocol machinery.

**Tech Stack:** `@modelcontextprotocol/sdk` (McpServer + StdioServerTransport), `zod` v4 for input schemas, `bun:sqlite` for DB access.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/mcp/tools.ts` | Pure tool handler functions: `handleSearch`, `handleTimeline`, `handleObserve` |
| `src/mcp/server.ts` | MCP server entry point: creates McpServer, registers tools, connects stdio transport |
| `tests/mcp/tools.test.ts` | Unit tests for tool handlers (real SQLite, no MCP protocol) |

---

## Chunk 1: Tool Handlers + Tests

### Task 1: Write failing tests for tool handlers

**Files:**
- Create: `tests/mcp/tools.test.ts`

- [ ] **Step 1: Create test file with all test cases**

```typescript
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
    const id1 = insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_read", title: "Read config", createdAt: 1000 });
    const id2 = insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "decision", title: "Chose approach", createdAt: 2000 });
    const id3 = insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: "Implemented approach", createdAt: 3000 });

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
    // Anchor is step 5 (id depends on insert order)
    const rows = db.prepare("SELECT id FROM observations ORDER BY created_at_epoch").all() as { id: number }[];
    const anchorId = rows[5].id;

    const result = handleTimeline(db, { anchor: anchorId, depth_before: 2, depth_after: 2 });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.length).toBe(5); // 2 before + anchor + 2 after
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/mcp/tools.test.ts`
Expected: FAIL — `handleSearch`, `handleTimeline`, `handleObserve` don't exist yet.

---

### Task 2: Implement tool handlers

**Files:**
- Create: `src/mcp/tools.ts`

- [ ] **Step 3: Implement handleSearch**

Uses existing `searchFts` from `src/pipelines/search/fts.ts`. Wraps result as `CallToolResult` with JSON text content.

```typescript
import type { Database } from "bun:sqlite";
import { searchFts } from "../pipelines/search/fts";
import type { Significance, ObservationKind } from "../types";

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface SearchInput {
  query: string;
  project?: string;
  significance?: Significance;
  kind?: ObservationKind;
  limit?: number;
}

export function handleSearch(db: Database, input: SearchInput): ToolResult {
  const { results, total_count } = searchFts(db, input.query, {
    project: input.project,
    significance: input.significance,
    kind: input.kind,
    limit: input.limit,
  });
  return {
    content: [{ type: "text", text: JSON.stringify({ results, total_count }) }],
  };
}
```

- [ ] **Step 4: Implement handleTimeline**

Fetches the anchor observation to get its session_id. Then fetches observations in that session ordered by created_at_epoch, windowed by depth_before/depth_after around the anchor.

```typescript
interface TimelineInput {
  anchor: number;
  depth_before?: number;
  depth_after?: number;
}

export function handleTimeline(db: Database, input: TimelineInput): ToolResult {
  const depthBefore = input.depth_before ?? 5;
  const depthAfter = input.depth_after ?? 5;

  const anchorRow = db.prepare(
    "SELECT session_id, created_at_epoch FROM observations WHERE id = ?"
  ).get(input.anchor) as { session_id: string; created_at_epoch: number } | null;

  if (!anchorRow) {
    return { content: [{ type: "text", text: `Observation #${input.anchor} not found` }], isError: true };
  }

  const before = db.prepare(
    `SELECT id, title, significance, kind, created_at_epoch
     FROM observations WHERE session_id = ? AND created_at_epoch < ?
     ORDER BY created_at_epoch DESC LIMIT ?`
  ).all(anchorRow.session_id, anchorRow.created_at_epoch, depthBefore) as any[];

  const anchor = db.prepare(
    `SELECT id, title, significance, kind, created_at_epoch
     FROM observations WHERE id = ?`
  ).get(input.anchor) as any;

  const after = db.prepare(
    `SELECT id, title, significance, kind, created_at_epoch
     FROM observations WHERE session_id = ? AND created_at_epoch > ?
     ORDER BY created_at_epoch ASC LIMIT ?`
  ).all(anchorRow.session_id, anchorRow.created_at_epoch, depthAfter) as any[];

  const timeline = [...before.reverse(), anchor, ...after];
  return { content: [{ type: "text", text: JSON.stringify(timeline) }] };
}
```

- [ ] **Step 5: Implement handleObserve**

Fetches full observation details for up to 10 IDs. Hard cap enforced.

```typescript
interface ObserveInput {
  ids: number[];
}

const MAX_OBSERVE_IDS = 10;

export function handleObserve(db: Database, input: ObserveInput): ToolResult {
  if (input.ids.length === 0) {
    return { content: [{ type: "text", text: "ids array must not be empty" }], isError: true };
  }
  if (input.ids.length > MAX_OBSERVE_IDS) {
    return { content: [{ type: "text", text: `Max ${MAX_OBSERVE_IDS} IDs per request (got ${input.ids.length})` }], isError: true };
  }

  const placeholders = input.ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, session_id, project, significance, kind, title, content, facts, concepts, files_read, files_modified, created_at_epoch
     FROM observations WHERE id IN (${placeholders})
     ORDER BY created_at_epoch`
  ).all(...input.ids);

  return { content: [{ type: "text", text: JSON.stringify(rows) }] };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/mcp/tools.test.ts`
Expected: All 12 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/tools.test.ts
git commit -m "feat: implement MCP tool handlers (search, timeline, observe)"
```

---

## Chunk 2: MCP Server Entry Point

### Task 3: MCP server with stdio transport

**Files:**
- Create: `src/mcp/server.ts`

- [ ] **Step 8: Implement MCP server entry point**

Creates a McpServer, registers three tools with zod schemas, and connects via StdioServerTransport. Reads DB path from `DEJA_DB_PATH` env var (or `~/.deja/memory.db` default).

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "../kernel/db";
import { runMigrations } from "../kernel/migrations";
import { handleSearch, handleTimeline, handleObserve } from "./tools";
import { join } from "path";
import { homedir } from "os";

const dbPath = process.env.DEJA_DB_PATH ?? join(homedir(), ".deja", "memory.db");
const db = openDb(dbPath);
runMigrations(db);

const server = new McpServer({
  name: "deja",
  version: "0.1.0",
});

server.tool(
  "deja_search",
  "Search observations by keyword. Returns lightweight index (id, title, significance, kind, date). Use this FIRST before deja_observe.",
  {
    query: z.string().describe("Search query"),
    project: z.string().optional().describe("Filter by project path"),
    significance: z.enum(["low", "medium", "high", "critical"]).optional().describe("Filter by significance level"),
    kind: z.enum(["file_read", "file_edit", "file_write", "bash_cmd", "decision", "prompt"]).optional().describe("Filter by observation kind"),
    limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20, max 50)"),
  },
  async (args) => handleSearch(db, args),
);

server.tool(
  "deja_timeline",
  "Get chronological context around an observation (same session only). Shows what happened before and after.",
  {
    anchor: z.number().int().describe("Observation ID to center timeline around"),
    depth_before: z.number().int().min(0).max(20).optional().describe("Items before anchor (default 5)"),
    depth_after: z.number().int().min(0).max(20).optional().describe("Items after anchor (default 5)"),
  },
  async (args) => handleTimeline(db, args),
);

server.tool(
  "deja_observe",
  "Fetch full observation details by ID. HARD CAP: max 10 IDs per request. Always filter through deja_search first.",
  {
    ids: z.array(z.number().int()).min(1).max(10).describe("Observation IDs to fetch (max 10)"),
  },
  async (args) => handleObserve(db, args),
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 9: Verify server starts without errors**

Run: `echo '{}' | timeout 2 bun run src/mcp/server.ts 2>&1 || true`
Expected: No crash. Server starts and waits for MCP protocol messages on stdin. May exit or hang — that's fine since we're not sending valid JSON-RPC.

- [ ] **Step 10: Run full test suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: All tests pass, no type errors.

- [ ] **Step 11: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat: add MCP server entry point with stdio transport"
```

---

### Task 4: Run full test suite and final verification

- [ ] **Step 12: Run full test suite**

Run: `bun test`
Expected: All tests pass (221 existing + 12 new = ~233).

- [ ] **Step 13: Typecheck**

Run: `bunx tsc --noEmit`
Expected: Clean.
