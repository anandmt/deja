# Plan 4: WAL + Socket + Worker

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the WAL failover, Unix socket IPC, pipeline orchestrator, and worker main loop — the runtime that connects all pipeline stages and processes events from hooks.

**Architecture:** Three new modules: WAL handles file-based failover when the worker is unreachable (lockfile-guarded append/drain); SocketServer provides NDJSON-over-Unix-socket IPC (with TCP fallback for Windows); Pipeline orchestrates classify → normalize → extract → store with classifier state tracking. The worker entry point wires these together with a Debouncer, idle timer, and signal handlers.

**Tech Stack:** Bun >= 1.3.6, TypeScript (strict), bun:test, bun:sqlite, bun:ffi (via existing lock.ts)

**Spec:** `docs/superpowers/specs/2026-05-22-deja-design.md` (lines 292-405, 912-954)

**Plan series:**
1. ~~Kernel~~ (done) — db, migrations, settings, lock, logging, shared types
2. ~~Ingest Pipeline~~ (done) — classify, normalize, debounce
3. ~~Heuristic Extract + FTS Store/Search~~ (done) — extract, store, search
4. **WAL + Socket + Worker** (this plan)
5. Hook Shims (4 hooks)
6. Context Injection (SessionStart generator)
7. MCP Server (4 tools)
8. CLI Commands (install, status, search, learn, stats, etc.)
9. Dashboard

---

## File Structure

```
src/
├── types.ts                  # Add IPC message types (EventMessage, RequestMessage, ResponseMessage)
├── kernel/
│   ├── wal.ts                # appendToWal, drainWal, walSize
│   └── socket.ts             # SocketServer, sendToWorker, requestFromWorker
├── worker/
│   ├── pipeline.ts           # Pipeline class (classify → normalize → extract → store)
│   └── main.ts               # Entry point (init, drain WAL, socket server, idle timer)
tests/
├── kernel/
│   ├── wal.test.ts
│   └── socket.test.ts
├── worker/
│   └── pipeline.test.ts
```

---

## Chunk 1: IPC Types + WAL Module

### Task 1: Add IPC message types to types.ts

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Append IPC types at the end of types.ts**

Add after the existing `ClassifyInput` interface:

```typescript
export interface EventMessage {
  type: "event";
  hook: HookType;
  payload: HookPayload;
}

export interface RequestMessage {
  type: "request";
  id: string;
  hook: HookType;
  payload: HookPayload;
}

export interface ResponseMessage {
  type: "response";
  id: string;
  status: "ok" | "error";
  data?: unknown;
}

export type WorkerMessage = EventMessage | RequestMessage;
```

- [ ] **Step 2: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add IPC message types for worker socket protocol"
```

---

### Task 2: Tests for WAL module

**Files:**
- Create: `tests/kernel/wal.test.ts`

- [ ] **Step 1: Write WAL tests**

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpDir } from "../../src/test/helpers";
import { appendToWal, drainWal, walSize } from "../../src/kernel/wal";

describe("appendToWal", () => {
  let dir: string;
  let walPath: string;
  let lockPath: string;

  afterEach(() => {
    try {
      const { rmSync } = require("fs");
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("creates WAL file and appends event", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    appendToWal(walPath, lockPath, '{"type":"event","hook":"PostToolUse"}');
    expect(existsSync(walPath)).toBe(true);
    const content = readFileSync(walPath, "utf-8");
    expect(content).toBe('{"type":"event","hook":"PostToolUse"}\n');
  });

  test("appends multiple events on separate lines", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    appendToWal(walPath, lockPath, '{"n":1}');
    appendToWal(walPath, lockPath, '{"n":2}');
    appendToWal(walPath, lockPath, '{"n":3}');
    const lines = readFileSync(walPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[2]).n).toBe(3);
  });
});

describe("drainWal", () => {
  let dir: string;
  let walPath: string;
  let lockPath: string;

  afterEach(() => {
    try {
      const { rmSync } = require("fs");
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("returns empty array when WAL does not exist", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    const events = drainWal(walPath, lockPath);
    expect(events).toEqual([]);
  });

  test("returns empty array when WAL is empty", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    writeFileSync(walPath, "");
    const events = drainWal(walPath, lockPath);
    expect(events).toEqual([]);
  });

  test("drains all valid events and truncates WAL", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    writeFileSync(walPath, '{"n":1}\n{"n":2}\n{"n":3}\n');
    const events = drainWal(walPath, lockPath);
    expect(events.length).toBe(3);
    expect(JSON.parse(events[0]).n).toBe(1);
    expect(JSON.parse(events[2]).n).toBe(3);
    expect(readFileSync(walPath, "utf-8")).toBe("");
  });

  test("skips incomplete last line (crash recovery)", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    writeFileSync(walPath, '{"n":1}\n{"n":2}\n{"incomplete":');
    const events = drainWal(walPath, lockPath);
    expect(events.length).toBe(2);
    expect(JSON.parse(events[1]).n).toBe(2);
  });

  test("skips malformed line in middle", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    writeFileSync(walPath, '{"n":1}\nNOT_JSON\n{"n":3}\n');
    const events = drainWal(walPath, lockPath);
    expect(events.length).toBe(2);
    expect(JSON.parse(events[0]).n).toBe(1);
    expect(JSON.parse(events[1]).n).toBe(3);
  });

  test("append then drain round-trips", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    appendToWal(walPath, lockPath, '{"round":"trip"}');
    const events = drainWal(walPath, lockPath);
    expect(events.length).toBe(1);
    expect(JSON.parse(events[0]).round).toBe("trip");
    expect(readFileSync(walPath, "utf-8")).toBe("");
  });
});

describe("walSize", () => {
  let dir: string;

  afterEach(() => {
    try {
      const { rmSync } = require("fs");
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("returns 0 when file does not exist", () => {
    dir = tmpDir();
    expect(walSize(join(dir, "nope.wal"))).toBe(0);
  });

  test("returns file size in bytes", () => {
    dir = tmpDir();
    const path = join(dir, "test.wal");
    writeFileSync(path, "hello\n");
    expect(walSize(path)).toBe(6);
  });
});

describe("appendToWal size cap", () => {
  let dir: string;
  let walPath: string;
  let lockPath: string;

  afterEach(() => {
    try {
      const { rmSync } = require("fs");
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("drops event when WAL exceeds 10MB", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    // Write a ~10MB file
    writeFileSync(walPath, "x".repeat(10 * 1024 * 1024 + 1));
    const sizeBefore = walSize(walPath);
    appendToWal(walPath, lockPath, '{"dropped":true}');
    expect(walSize(walPath)).toBe(sizeBefore);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/kernel/wal.test.ts`
Expected: FAIL — imports not found

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/kernel/wal.test.ts
git commit -m "test: add failing tests for WAL append/drain/size/cap (11 cases)"
```

---

### Task 3: Implement WAL module

**Files:**
- Create: `src/kernel/wal.ts`

- [ ] **Step 1: Implement WAL functions**

```typescript
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from "fs";
import { acquireLock, releaseLock } from "./lock";
import type { Logger } from "./log";

const WAL_WARN_BYTES = 8 * 1024 * 1024;
const WAL_MAX_BYTES = 10 * 1024 * 1024;

export function appendToWal(
  walPath: string,
  lockPath: string,
  event: string,
  log?: Logger,
): void {
  const fd = acquireLock(lockPath);
  try {
    const size = walSize(walPath);
    if (size >= WAL_MAX_BYTES) {
      log?.("warn", "wal", `WAL at ${size} bytes — dropping event (worker may be down)`);
      return;
    }
    if (size >= WAL_WARN_BYTES) {
      log?.("warn", "wal", `WAL approaching limit: ${size} bytes`);
    }
    appendFileSync(walPath, event + "\n");
  } finally {
    releaseLock(fd);
  }
}

export function drainWal(
  walPath: string,
  lockPath: string,
  log?: Logger,
): string[] {
  if (!existsSync(walPath)) return [];

  const fd = acquireLock(lockPath);
  try {
    const raw = readFileSync(walPath, "utf-8");
    if (!raw.trim()) return [];

    writeFileSync(walPath, "");

    const lines = raw.split("\n").filter((l) => l.trim());
    const events: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        JSON.parse(lines[i]);
        events.push(lines[i]);
      } catch {
        if (i === lines.length - 1) {
          log?.("warn", "wal", "Skipped incomplete last line in WAL");
        } else {
          log?.("warn", "wal", `Skipped malformed line ${i} in WAL`);
        }
      }
    }

    return events;
  } finally {
    releaseLock(fd);
  }
}

export function walSize(walPath: string): number {
  try {
    return statSync(walPath).size;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/kernel/wal.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/kernel/wal.ts
git commit -m "feat: implement WAL append/drain with lockfile protocol"
```

---

## Chunk 2: Socket Module

### Task 4: Tests for socket server and client

**Files:**
- Create: `tests/kernel/socket.test.ts`

- [ ] **Step 1: Write socket tests**

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { rmSync } from "fs";
import { tmpDir } from "../../src/test/helpers";
import {
  SocketServer,
  sendToWorker,
  requestFromWorker,
} from "../../src/kernel/socket";

describe("SocketServer", () => {
  let dir: string;
  let socketPath: string;
  let server: SocketServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("receives fire-and-forget message", async () => {
    dir = tmpDir();
    socketPath = join(dir, "test.sock");
    const received: unknown[] = [];

    server = new SocketServer({
      socketPath,
      onMessage: (msg) => {
        received.push(msg);
      },
    });
    server.start();

    await sendToWorker(socketPath, {
      type: "event",
      hook: "PostToolUse",
      payload: { session_id: "s1", cwd: "/test" },
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBe(1);
    expect((received[0] as any).type).toBe("event");
  });

  test("receives multiple messages from separate clients", async () => {
    dir = tmpDir();
    socketPath = join(dir, "test.sock");
    const received: unknown[] = [];

    server = new SocketServer({
      socketPath,
      onMessage: (msg) => {
        received.push(msg);
      },
    });
    server.start();

    await sendToWorker(socketPath, { type: "event", n: 1 });
    await sendToWorker(socketPath, { type: "event", n: 2 });
    await sendToWorker(socketPath, { type: "event", n: 3 });

    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBe(3);
  });

  test("handles request-response pattern", async () => {
    dir = tmpDir();
    socketPath = join(dir, "test.sock");

    server = new SocketServer({
      socketPath,
      onMessage: (msg, respond) => {
        if (msg.type === "request") {
          respond({ type: "response", id: msg.id, status: "ok" });
        }
      },
    });
    server.start();

    const response = await requestFromWorker(
      socketPath,
      { type: "request", id: "req-1", hook: "Stop", payload: {} },
      5000,
    );

    expect(response.type).toBe("response");
    expect(response.id).toBe("req-1");
    expect(response.status).toBe("ok");
  });

  test("requestFromWorker times out when no response", async () => {
    dir = tmpDir();
    socketPath = join(dir, "test.sock");

    server = new SocketServer({
      socketPath,
      onMessage: () => {
        // intentionally no response
      },
    });
    server.start();

    await expect(
      requestFromWorker(
        socketPath,
        { type: "request", id: "req-2", hook: "Stop", payload: {} },
        200,
      ),
    ).rejects.toThrow(/timed out/i);
  });

  test("sendToWorker rejects when no server is listening", async () => {
    dir = tmpDir();
    socketPath = join(dir, "nonexistent.sock");

    await expect(
      sendToWorker(socketPath, { type: "event" }),
    ).rejects.toThrow();
  });

  test("handles multiple newline-delimited messages in one data chunk", async () => {
    dir = tmpDir();
    socketPath = join(dir, "test.sock");
    const received: unknown[] = [];

    server = new SocketServer({
      socketPath,
      onMessage: (msg) => {
        received.push(msg);
      },
    });
    server.start();

    // Send two messages in a single write
    const socket = await Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          s.write('{"n":1}\n{"n":2}\n');
          s.end();
        },
        data() {},
        close() {},
        error() {},
      },
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBe(2);
    expect((received[0] as any).n).toBe(1);
    expect((received[1] as any).n).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/kernel/socket.test.ts`
Expected: FAIL — imports not found

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/kernel/socket.test.ts
git commit -m "test: add failing tests for socket server/client (6 cases)"
```

---

### Task 5: Implement socket module

**Files:**
- Create: `src/kernel/socket.ts`

- [ ] **Step 1: Implement SocketServer, sendToWorker, requestFromWorker**

```typescript
import { unlinkSync } from "fs";
import type { Logger } from "./log";

export interface SocketServerOptions {
  socketPath: string;
  onMessage: (msg: any, respond: (response: any) => void) => void;
  onError?: (err: Error) => void;
  log?: Logger;
}

export class SocketServer {
  private server: ReturnType<typeof Bun.listen> | null = null;

  constructor(private options: SocketServerOptions) {}

  start(): void {
    const { socketPath, onMessage, onError, log } = this.options;

    try {
      unlinkSync(socketPath);
    } catch {}

    this.server = Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          (socket as any).ndjsonBuffer = "";
        },
        data(socket, data) {
          (socket as any).ndjsonBuffer += data.toString();
          const buf: string = (socket as any).ndjsonBuffer;
          const lines = buf.split("\n");
          (socket as any).ndjsonBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              onMessage(msg, (response: any) => {
                socket.write(JSON.stringify(response) + "\n");
              });
            } catch {
              log?.("warn", "socket", `Invalid JSON from client: ${line.slice(0, 100)}`);
            }
          }
        },
        close() {},
        error(socket, error) {
          onError?.(error);
        },
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }
}

export async function sendToWorker(
  socketPath: string,
  message: unknown,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(message) + "\n");
          socket.end();
        },
        data() {},
        close() {
          resolve();
        },
        error(_socket, err) {
          reject(err);
        },
        connectError(_socket, err) {
          reject(err);
        },
      },
    }).catch(reject);
  });
}

export async function requestFromWorker(
  socketPath: string,
  message: unknown,
  timeoutMs: number = 10000,
): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Request timed out"));
      }
    }, timeoutMs);

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(message) + "\n");
        },
        data(socket, data) {
          if (settled) return;
          buffer += data.toString();
          const idx = buffer.indexOf("\n");
          if (idx !== -1) {
            settled = true;
            clearTimeout(timer);
            try {
              const response = JSON.parse(buffer.slice(0, idx));
              socket.end();
              resolve(response);
            } catch {
              socket.end();
              reject(new Error("Invalid response JSON"));
            }
          }
        },
        close() {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error("Connection closed without response"));
          }
        },
        error(_socket, err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        },
        connectError(_socket, err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        },
      },
    }).catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/kernel/socket.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/kernel/socket.ts
git commit -m "feat: implement NDJSON socket server with fire-and-forget and request-response"
```

---

## Chunk 3: Pipeline Orchestrator

### Task 6: Tests for pipeline orchestrator

**Files:**
- Create: `tests/worker/pipeline.test.ts`

- [ ] **Step 1: Write pipeline tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/worker/pipeline.test.ts`
Expected: FAIL — imports not found

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/worker/pipeline.test.ts
git commit -m "test: add failing tests for pipeline orchestrator (12 cases)"
```

---

### Task 7: Implement pipeline orchestrator

**Files:**
- Create: `src/worker/pipeline.ts`

- [ ] **Step 1: Implement Pipeline class**

```typescript
import type { Database } from "bun:sqlite";
import type {
  HookPayload,
  BatchAnnotation,
  ClassifyInput,
  Settings,
} from "../types";
import type { Logger } from "../kernel/log";
import { classify } from "../pipelines/ingest/classify";
import { normalize } from "../pipelines/ingest/normalize";
import { extractHeuristic } from "../pipelines/extract/heuristic";

export class Pipeline {
  private recentCommands = new Set<string>();
  private seenWritePaths = new Set<string>();

  private stmtEnsureSession: ReturnType<Database["prepare"]>;
  private stmtIncrementStat: ReturnType<Database["prepare"]>;
  private stmtInsertObs: ReturnType<Database["prepare"]>;

  constructor(
    private db: Database,
    private settings: Settings,
    private log: Logger,
  ) {
    this.stmtEnsureSession = db.prepare(
      "INSERT OR IGNORE INTO sessions (id, project, started_at_epoch) VALUES (?, ?, ?)",
    );
    this.stmtIncrementStat = db.prepare(
      `INSERT INTO stats (project, metric, value) VALUES (?, ?, 1)
       ON CONFLICT(project, metric) DO UPDATE SET value = value + 1`,
    );
    this.stmtInsertObs = db.prepare(
      `INSERT INTO observations (session_id, project, significance, kind, title, content,
        facts, concepts, files_read, files_modified, raw_event, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  processEvent(payload: HookPayload, batch: BatchAnnotation): void {
    const input: ClassifyInput = {
      payload,
      recentCommands: this.recentCommands,
      seenWritePaths: this.seenWritePaths,
      settings: this.settings,
      batch,
    };

    const classified = classify(input);

    this.trackState(payload);

    if (classified.significance === "skip") {
      this.stmtIncrementStat.run(payload.cwd, "events_skipped");
      return;
    }

    this.stmtEnsureSession.run(payload.session_id, payload.cwd, Date.now());

    const normalized = normalize(payload);
    const extracted = extractHeuristic(normalized, classified);

    this.stmtInsertObs.run(
      payload.session_id,
      payload.cwd,
      classified.significance,
      extracted.kind,
      extracted.title,
      extracted.content,
      JSON.stringify(extracted.facts),
      JSON.stringify(extracted.concepts),
      JSON.stringify(extracted.files_read),
      JSON.stringify(extracted.files_modified),
      normalized.raw_event,
      Date.now(),
    );

    this.stmtIncrementStat.run(payload.cwd, "events_stored");
    this.log("debug", "pipeline", `Stored: ${extracted.title}`);
  }

  private trackState(payload: HookPayload): void {
    if (payload.type !== "PostToolUse") return;
    const tool = (payload as any).tool as string | undefined;

    if (tool === "Bash") {
      const cmd = ((payload as any).input?.command ?? "") as string;
      if (cmd) this.recentCommands.add(`${cmd}:${Date.now()}`);
    }

    if (tool === "Write") {
      const fp = ((payload as any).input?.file_path ?? "") as string;
      if (fp) this.seenWritePaths.add(fp);
    }
  }
}
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/worker/pipeline.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/worker/pipeline.ts
git commit -m "feat: implement pipeline orchestrator (classify → normalize → extract → store)"
```

---

## Chunk 4: Worker Entry Point

### Task 8: Implement worker main.ts

**Files:**
- Create: `src/worker/main.ts`

The worker entry point is primarily wiring — it connects the Pipeline, Debouncer, SocketServer, and WAL drain. It is tested indirectly through the unit tests of its components and will be tested end-to-end in Plan 5 (Hook Shims).

- [ ] **Step 1: Implement worker main**

```typescript
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { paths } from "../paths";
import { openDb } from "../kernel/db";
import { runMigrations } from "../kernel/migrations";
import { readSettings } from "../kernel/settings";
import { createLogger, rotateOldLogs } from "../kernel/log";
import { drainWal } from "../kernel/wal";
import { SocketServer } from "../kernel/socket";
import { Debouncer } from "../pipelines/ingest/debounce";
import { Pipeline } from "./pipeline";
import type { HookPayload, BatchAnnotation } from "../types";

function main(): void {
  mkdirSync(paths.dejaDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  const db = openDb(paths.db);
  runMigrations(db);
  const settings = readSettings(paths.settings);
  const log = createLogger(settings.log_level, paths.logsDir);

  log("info", "worker", `Starting deja worker (PID ${process.pid})`);

  rotateOldLogs(paths.logsDir, settings.log_max_days);

  const pipeline = new Pipeline(db, settings, log);

  const walEvents = drainWal(paths.pendingWal, paths.walLock, log);
  if (walEvents.length > 0) {
    log("info", "worker", `Draining ${walEvents.length} events from WAL`);
    const defaultBatch: BatchAnnotation = {
      batch_size: 1,
      batch_index: 0,
      multi_file_edit: false,
      unique_files: [],
    };
    for (const eventJson of walEvents) {
      try {
        const payload = JSON.parse(eventJson) as HookPayload;
        pipeline.processEvent(payload, defaultBatch);
      } catch (err) {
        log("error", "worker", `Failed to process WAL event: ${err}`);
      }
    }
  }

  const debouncer = new Debouncer(settings.debounce_ms, (payload, batch) => {
    try {
      pipeline.processEvent(payload, batch);
    } catch (err) {
      log("error", "worker", `Pipeline error: ${err}`);
    }
  });

  let idleTimer: ReturnType<typeof setTimeout>;
  const idleTimeoutMs = settings.worker_idle_timeout_minutes * 60 * 1000;

  function resetIdleTimer(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, idleTimeoutMs);
  }

  const socketPath = process.platform === "win32" ? undefined : paths.workerSock;

  const server = new SocketServer({
    socketPath: socketPath ?? `127.0.0.1:${settings.tcp_port}`,
    onMessage: (msg, respond) => {
      resetIdleTimer();

      if (msg.type === "event") {
        debouncer.push(msg.payload as HookPayload);
      } else if (msg.type === "request") {
        debouncer.push(msg.payload as HookPayload);
        debouncer.flush();
        respond({ type: "response", id: msg.id, status: "ok" });
      }
    },
    onError: (err) => {
      log("error", "socket", `Socket error: ${err.message}`);
    },
    log,
  });

  server.start();
  writeFileSync(paths.workerPid, String(process.pid));
  log("info", "worker", `Listening on ${socketPath ?? `TCP :${settings.tcp_port}`}`);
  resetIdleTimer();

  function shutdown(): void {
    log("info", "worker", "Shutting down (idle timeout or signal)");
    clearTimeout(idleTimer);
    debouncer.flush();
    debouncer.destroy();
    server.stop();

    try {
      unlinkSync(paths.workerSock);
    } catch {}
    try {
      unlinkSync(paths.workerPid);
    } catch {}

    log.flush();
    db.close();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
}

main();
```

- [ ] **Step 2: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Smoke test — verify worker starts and shuts down**

Run with a short idle timeout to verify the startup/shutdown cycle:

```bash
timeout 5 bun run src/worker/main.ts || true
```

Expected: Worker starts, creates `~/.deja/worker.pid`, shuts down via timeout. Check logs at `~/.deja/logs/` for "Starting deja worker" message.

- [ ] **Step 4: Commit**

```bash
git add src/worker/main.ts
git commit -m "feat: implement worker entry point with WAL drain, socket server, and idle shutdown"
```

---

## Chunk 5: Verification

### Task 9: Run full test suite and verify

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: ALL PASS — kernel + ingest + extract + FTS + WAL + socket + pipeline

- [ ] **Step 2: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Final commit if needed**

```bash
git status
# Only commit if there are uncommitted changes
```
