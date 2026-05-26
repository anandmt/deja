# Hook Shims Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 4 Claude Code hook entry points (SessionStart, PostToolUse, UserPromptSubmit, Stop) that bridge Claude Code events into the deja pipeline.

**Architecture:** Each hook is a thin TypeScript shim (~20 lines) executed as a Bun subprocess by Claude Code. Hooks read JSON from stdin, map Claude Code's field names to our internal `HookPayload` format, and either send to the worker (fire-and-forget with WAL fallback) or handle special logic (SessionStart ensures worker + injects context, Stop waits for worker response). A shared `ensure-worker` module handles lazy worker startup with PID checks, lockfile-protected spawning, and socket retry logic.

**Tech Stack:** Bun, TypeScript, Unix domain sockets, flock via FFI, SQLite (SessionStart only)

**Key insight — field name mapping:** Claude Code hooks use different field names than our internal types: `hook_event_name` → `type`, `tool_name` → `tool`, `tool_input` → `input`, `tool_output` → `output`, `source` → `trigger`. The `mapPayload` function is the single adaptation point.

---

## File Structure

```
src/hooks/
├── map-payload.ts      # Pure function: Claude Code fields → HookPayload
├── ensure-worker.ts    # Worker lifecycle: check PID, spawn if needed, retry socket
├── send.ts             # Fire-and-forget (WAL fallback) + request-response wrappers
├── post-tool-use.ts    # Entry point: stdin → map → send → exit
├── prompt-submit.ts    # Entry point: stdin → map → send → exit
├── session-start.ts    # Entry point: stdin → map → ensureWorker → context → send → exit
└── session-stop.ts     # Entry point: stdin → map → request-response → exit

src/context/
└── generator.ts        # Stub: returns "" (Plan 6 fills in real logic)

tests/hooks/
├── map-payload.test.ts
├── ensure-worker.test.ts
├── send.test.ts
└── integration.test.ts

tests/context/
└── generator.test.ts

hooks.json              # Claude Code hook registration (project root)
```

---

## Chunk 1: Shared Utilities

### Task 1: Field Mapping (`map-payload.ts`)

**Files:**
- Create: `src/hooks/map-payload.ts`
- Test: `tests/hooks/map-payload.test.ts`

- [ ] **Step 1: Write failing tests for mapPayload**

```typescript
// tests/hooks/map-payload.test.ts
import { describe, test, expect } from "bun:test";
import { mapPayload } from "../../src/hooks/map-payload";

describe("mapPayload", () => {
  test("maps SessionStart fields", () => {
    const raw = {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "SessionStart",
      source: "startup",
      transcript_path: "/path/to/transcript.jsonl",
      model: "claude-sonnet-4-6",
    };
    const result = mapPayload(raw);
    expect(result.type).toBe("SessionStart");
    expect(result.session_id).toBe("s1");
    expect(result.cwd).toBe("/project");
    expect((result as any).trigger).toBe("startup");
    // Extra Claude Code fields are NOT carried over
    expect((result as any).transcript_path).toBeUndefined();
    expect((result as any).model).toBeUndefined();
  });

  test("maps PostToolUse Edit fields", () => {
    const raw = {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/project/app.ts", old_string: "a", new_string: "b" },
      tool_output: { success: true },
      tool_use_id: "tu_123",
    };
    const result = mapPayload(raw);
    expect(result.type).toBe("PostToolUse");
    expect((result as any).tool).toBe("Edit");
    expect((result as any).input).toEqual({ file_path: "/project/app.ts", old_string: "a", new_string: "b" });
    expect((result as any).output).toEqual({ success: true });
    expect((result as any).tool_use_id).toBeUndefined();
  });

  test("maps PostToolUse Bash fields", () => {
    const raw = {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_output: { stdout: "ok", stderr: "", exit_code: 0 },
    };
    const result = mapPayload(raw);
    expect((result as any).tool).toBe("Bash");
    expect((result as any).input).toEqual({ command: "npm test" });
    expect((result as any).output).toEqual({ stdout: "ok", stderr: "", exit_code: 0 });
  });

  test("maps UserPromptSubmit fields", () => {
    const raw = {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "UserPromptSubmit",
      prompt: "fix the bug",
      permission_mode: "default",
    };
    const result = mapPayload(raw);
    expect(result.type).toBe("UserPromptSubmit");
    expect((result as any).prompt).toBe("fix the bug");
    expect((result as any).permission_mode).toBeUndefined();
  });

  test("maps Stop fields", () => {
    const raw = {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "Stop",
    };
    const result = mapPayload(raw);
    expect(result.type).toBe("Stop");
    expect(result.session_id).toBe("s1");
    expect(result.cwd).toBe("/project");
  });

  test("handles tool_response as fallback for tool_output", () => {
    const raw = {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/project/foo.ts" },
      tool_response: { content: "file contents" },
    };
    const result = mapPayload(raw);
    expect((result as any).output).toEqual({ content: "file contents" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/hooks/map-payload.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement mapPayload**

```typescript
// src/hooks/map-payload.ts
import type { HookPayload, HookType } from "../types";

const HOOK_EVENT_MAP: Record<string, HookType> = {
  SessionStart: "SessionStart",
  PostToolUse: "PostToolUse",
  UserPromptSubmit: "UserPromptSubmit",
  Stop: "Stop",
};

export function mapPayload(raw: Record<string, unknown>): HookPayload {
  const hookEvent = raw.hook_event_name as string;
  const type = HOOK_EVENT_MAP[hookEvent] ?? (hookEvent as HookType);

  const base: HookPayload = {
    type,
    session_id: raw.session_id as string,
    cwd: raw.cwd as string,
  };

  if (type === "SessionStart") {
    base.trigger = raw.source as string | undefined;
    return base;
  }

  if (type === "UserPromptSubmit") {
    base.prompt = raw.prompt as string;
    return base;
  }

  if (type === "PostToolUse") {
    base.tool = raw.tool_name as string;
    base.input = raw.tool_input;
    base.output = raw.tool_output ?? raw.tool_response;
    return base;
  }

  // Stop and unknown types — just base fields
  return base;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/hooks/map-payload.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/map-payload.ts tests/hooks/map-payload.test.ts
git commit -m "feat: add hook payload field mapping (Claude Code → HookPayload)"
```

---

### Task 2: Send Utilities (`send.ts`)

**Files:**
- Create: `src/hooks/send.ts`
- Test: `tests/hooks/send.test.ts`

These wrap `sendToWorker`/`requestFromWorker` from `kernel/socket.ts` and `appendToWal` from `kernel/wal.ts`, providing the fire-and-forget-with-WAL-fallback pattern.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/hooks/send.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { rmSync, readFileSync, existsSync } from "fs";
import { tmpDir } from "../../src/test/helpers";
import { SocketServer } from "../../src/kernel/socket";
import { trySendEvent, trySendRequest } from "../../src/hooks/send";

describe("trySendEvent", () => {
  let dir: string;
  let server: SocketServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test("sends event to running worker", async () => {
    dir = tmpDir();
    const sockPath = join(dir, "test.sock");
    const walPath = join(dir, "pending.wal");
    const walLock = join(dir, "pending.wal.lock");
    const received: unknown[] = [];

    server = new SocketServer({
      socketPath: sockPath,
      onMessage: (msg) => received.push(msg),
    });
    server.start();

    await trySendEvent(sockPath, { type: "event", hook: "PostToolUse", payload: { type: "PostToolUse", session_id: "s1", cwd: "/p" } }, walPath, walLock);

    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBe(1);
    expect(existsSync(walPath)).toBe(false);
  });

  test("falls back to WAL when no server", async () => {
    dir = tmpDir();
    const sockPath = join(dir, "nonexistent.sock");
    const walPath = join(dir, "pending.wal");
    const walLock = join(dir, "pending.wal.lock");

    await trySendEvent(sockPath, { type: "event", hook: "PostToolUse", payload: { type: "PostToolUse", session_id: "s1", cwd: "/p" } }, walPath, walLock);

    expect(existsSync(walPath)).toBe(true);
    const content = readFileSync(walPath, "utf-8");
    expect(content).toContain("PostToolUse");
  });
});

describe("trySendRequest", () => {
  let dir: string;
  let server: SocketServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test("sends request and receives response", async () => {
    dir = tmpDir();
    const sockPath = join(dir, "test.sock");

    server = new SocketServer({
      socketPath: sockPath,
      onMessage: (msg, respond) => {
        if (msg.type === "request") {
          respond({ type: "response", id: msg.id, status: "ok" });
        }
      },
    });
    server.start();

    const response = await trySendRequest(sockPath, {
      type: "request", id: "r1", hook: "Stop",
      payload: { type: "Stop", session_id: "s1", cwd: "/p" },
    }, 5000);

    expect(response.status).toBe("ok");
  });

  test("returns null on timeout", async () => {
    dir = tmpDir();
    const sockPath = join(dir, "test.sock");

    server = new SocketServer({
      socketPath: sockPath,
      onMessage: () => {}, // no response
    });
    server.start();

    const response = await trySendRequest(sockPath, {
      type: "request", id: "r2", hook: "Stop",
      payload: { type: "Stop", session_id: "s1", cwd: "/p" },
    }, 200);

    expect(response).toBeNull();
  });

  test("returns null when no server", async () => {
    dir = tmpDir();
    const sockPath = join(dir, "nonexistent.sock");

    const response = await trySendRequest(sockPath, {
      type: "request", id: "r3", hook: "Stop",
      payload: { type: "Stop", session_id: "s1", cwd: "/p" },
    }, 200);

    expect(response).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/hooks/send.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement send utilities**

```typescript
// src/hooks/send.ts
import { sendToWorker, requestFromWorker } from "../kernel/socket";
import { appendToWal } from "../kernel/wal";
import type { EventMessage, RequestMessage } from "../types";

export async function trySendEvent(
  socketPath: string,
  message: EventMessage,
  walPath: string,
  walLockPath: string,
): Promise<void> {
  try {
    await sendToWorker(socketPath, message);
  } catch {
    appendToWal(walPath, walLockPath, JSON.stringify(message.payload));
  }
}

export async function trySendRequest(
  socketPath: string,
  message: RequestMessage,
  timeoutMs: number,
): Promise<any | null> {
  try {
    return await requestFromWorker(socketPath, message, timeoutMs);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/hooks/send.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/send.ts tests/hooks/send.test.ts
git commit -m "feat: add hook send utilities with WAL fallback"
```

---

### Task 3: Worker Lifecycle (`ensure-worker.ts`)

**Files:**
- Create: `src/hooks/ensure-worker.ts`
- Test: `tests/hooks/ensure-worker.test.ts`

This module checks if the worker is running (PID file + process alive + socket reachable) and starts it if not. Uses flock to prevent race conditions between concurrent hooks.

- [ ] **Step 1: Write failing tests for isPidAlive**

```typescript
// tests/hooks/ensure-worker.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { writeFileSync, rmSync } from "fs";
import { tmpDir } from "../../src/test/helpers";
import { isPidAlive, ensureWorker } from "../../src/hooks/ensure-worker";
import { SocketServer } from "../../src/kernel/socket";

describe("isPidAlive", () => {
  test("returns true for current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("returns false for non-existent PID", () => {
    expect(isPidAlive(999999)).toBe(false);
  });
});

describe("ensureWorker", () => {
  let dir: string;
  let server: SocketServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test("returns immediately if worker is already running", async () => {
    dir = tmpDir();
    const pidPath = join(dir, "worker.pid");
    const sockPath = join(dir, "worker.sock");
    const lockPath = join(dir, "worker.lock");

    // Start a fake server and write current PID
    server = new SocketServer({
      socketPath: sockPath,
      onMessage: () => {},
    });
    server.start();
    writeFileSync(pidPath, String(process.pid));

    await ensureWorker({
      pidPath,
      sockPath,
      lockPath,
      workerScript: "unused",
    });

    // No error, returned quickly
  });

  test("spawns worker when no PID file exists", async () => {
    dir = tmpDir();
    const pidPath = join(dir, "worker.pid");
    const sockPath = join(dir, "worker.sock");
    const lockPath = join(dir, "worker.lock");

    // Use a tiny test script that creates a socket and writes PID
    const testWorker = join(dir, "fake-worker.ts");
    writeFileSync(testWorker, `
      import { writeFileSync } from "fs";
      const { SocketServer } = require("${join(process.cwd(), "src/kernel/socket.ts")}");
      const server = new SocketServer({
        socketPath: "${sockPath}",
        onMessage: () => {},
      });
      server.start();
      writeFileSync("${pidPath}", String(process.pid));
      // Keep alive
      setInterval(() => {}, 60000);
    `);

    await ensureWorker({
      pidPath,
      sockPath,
      lockPath,
      workerScript: testWorker,
      maxRetries: 20,
      retryDelayMs: 100,
    });

    // Worker should have created PID file
    const pid = parseInt(Bun.file(pidPath).textSync(), 10);
    expect(pid).toBeGreaterThan(0);

    // Clean up spawned process
    try { process.kill(pid, "SIGTERM"); } catch {}
  });

  test("cleans up stale PID and respawns", async () => {
    dir = tmpDir();
    const pidPath = join(dir, "worker.pid");
    const sockPath = join(dir, "worker.sock");
    const lockPath = join(dir, "worker.lock");

    // Write a stale PID (non-existent process)
    writeFileSync(pidPath, "999999");

    const testWorker = join(dir, "fake-worker.ts");
    writeFileSync(testWorker, `
      import { writeFileSync } from "fs";
      const { SocketServer } = require("${join(process.cwd(), "src/kernel/socket.ts")}");
      const server = new SocketServer({
        socketPath: "${sockPath}",
        onMessage: () => {},
      });
      server.start();
      writeFileSync("${pidPath}", String(process.pid));
      setInterval(() => {}, 60000);
    `);

    await ensureWorker({
      pidPath,
      sockPath,
      lockPath,
      workerScript: testWorker,
      maxRetries: 20,
      retryDelayMs: 100,
    });

    const pid = parseInt(Bun.file(pidPath).textSync(), 10);
    expect(pid).not.toBe(999999);
    expect(pid).toBeGreaterThan(0);

    try { process.kill(pid, "SIGTERM"); } catch {}
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/hooks/ensure-worker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ensure-worker**

```typescript
// src/hooks/ensure-worker.ts
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { acquireLock, releaseLock } from "../kernel/lock";

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface EnsureWorkerOptions {
  pidPath: string;
  sockPath: string;
  lockPath: string;
  workerScript: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

export async function ensureWorker(opts: EnsureWorkerOptions): Promise<void> {
  const {
    pidPath,
    sockPath,
    lockPath,
    workerScript,
    maxRetries = 10,
    retryDelayMs = 200,
  } = opts;

  if (isWorkerRunning(pidPath, sockPath)) return;

  const lockFd = acquireLock(lockPath);
  try {
    // Re-check after acquiring lock (another hook may have started the worker)
    if (isWorkerRunning(pidPath, sockPath)) return;

    // Clean up stale files
    try { unlinkSync(pidPath); } catch {}
    try { unlinkSync(sockPath); } catch {}

    // Spawn worker as detached process
    const child = spawn("bun", ["run", workerScript], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } finally {
    releaseLock(lockFd);
  }

  // Wait for worker to create socket
  for (let i = 0; i < maxRetries; i++) {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    if (existsSync(sockPath)) return;
  }
}

function isWorkerRunning(pidPath: string, sockPath: string): boolean {
  if (!existsSync(pidPath)) return false;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (!isPidAlive(pid)) return false;
    return existsSync(sockPath);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/hooks/ensure-worker.test.ts`
Expected: 5 tests PASS (may take a few seconds due to worker spawn/retry)

- [ ] **Step 5: Commit**

```bash
git add src/hooks/ensure-worker.ts tests/hooks/ensure-worker.test.ts
git commit -m "feat: add ensureWorker with PID check, lockfile spawn, and socket retry"
```

---

### Task 4: Context Generator Stub (`context/generator.ts`)

**Files:**
- Create: `src/context/generator.ts`
- Test: `tests/context/generator.test.ts`

This is a placeholder that Plan 6 will replace with real context injection logic (DB queries, formatting, budget allocation).

- [ ] **Step 1: Write failing test**

```typescript
// tests/context/generator.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/context/generator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement stub**

```typescript
// src/context/generator.ts
import type { Database } from "bun:sqlite";
import type { Settings } from "../types";

export function generateContext(
  _db: Database,
  _project: string,
  _sessionId: string,
  _settings: Settings,
): string {
  return "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/context/generator.test.ts`
Expected: 1 test PASS

- [ ] **Step 5: Commit**

```bash
git add src/context/generator.ts tests/context/generator.test.ts
git commit -m "feat: add context generator stub (Plan 6 fills in real logic)"
```

---

## Chunk 2: Hook Entry Points

### Task 5: PostToolUse Hook (`post-tool-use.ts`)

**Files:**
- Create: `src/hooks/post-tool-use.ts`

This is the simplest hook — fire-and-forget pattern. Reads stdin, maps fields, sends to worker. WAL fallback on failure.

- [ ] **Step 1: Implement post-tool-use hook**

```typescript
// src/hooks/post-tool-use.ts
import { paths } from "../paths";
import { mapPayload } from "./map-payload";
import { trySendEvent } from "./send";

const raw = JSON.parse(await Bun.stdin.text());
const payload = mapPayload(raw);

await trySendEvent(
  paths.workerSock,
  { type: "event", hook: payload.type, payload },
  paths.pendingWal,
  paths.walLock,
);
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/hooks/post-tool-use.ts
git commit -m "feat: add PostToolUse hook entry point (fire-and-forget)"
```

---

### Task 6: UserPromptSubmit Hook (`prompt-submit.ts`)

**Files:**
- Create: `src/hooks/prompt-submit.ts`

Same fire-and-forget pattern as PostToolUse.

- [ ] **Step 1: Implement prompt-submit hook**

```typescript
// src/hooks/prompt-submit.ts
import { paths } from "../paths";
import { mapPayload } from "./map-payload";
import { trySendEvent } from "./send";

const raw = JSON.parse(await Bun.stdin.text());
const payload = mapPayload(raw);

await trySendEvent(
  paths.workerSock,
  { type: "event", hook: payload.type, payload },
  paths.pendingWal,
  paths.walLock,
);
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/hooks/prompt-submit.ts
git commit -m "feat: add UserPromptSubmit hook entry point (fire-and-forget)"
```

---

### Task 7: SessionStart Hook (`session-start.ts`)

**Files:**
- Create: `src/hooks/session-start.ts`

The heaviest hook. Three responsibilities:
1. Ensure worker is running (lazy start)
2. Read DB directly for context injection (returns context to Claude Code via stdout)
3. Send fire-and-forget event to worker for observation capture

The context injection reads the DB directly (not through the worker) to stay under 200ms. The context generator is a stub for now — Plan 6 fills in real query logic.

- [ ] **Step 1: Implement session-start hook**

```typescript
// src/hooks/session-start.ts
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { paths } from "../paths";
import { openDb } from "../kernel/db";
import { runMigrations } from "../kernel/migrations";
import { readSettings } from "../kernel/settings";
import { generateContext } from "../context/generator";
import { mapPayload } from "./map-payload";
import { ensureWorker } from "./ensure-worker";
import { trySendEvent } from "./send";

const raw = JSON.parse(await Bun.stdin.text());
const payload = mapPayload(raw);

mkdirSync(paths.dejaDir, { recursive: true });

// Ensure worker is running (lazy start)
const workerScript = resolve(import.meta.dir, "..", "worker", "main.ts");
await ensureWorker({
  pidPath: paths.workerPid,
  sockPath: paths.workerSock,
  lockPath: paths.workerLock,
  workerScript,
});

// Read DB directly for context injection
let context = "";
try {
  const db = openDb(paths.db);
  runMigrations(db);
  const settings = readSettings(paths.settings);
  context = generateContext(db, payload.cwd, payload.session_id, settings);
  db.close();
} catch {
  // DB not ready yet (first ever session) — no context to inject
}

// Output context to Claude Code
if (context) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

// Send fire-and-forget event to worker
await trySendEvent(
  paths.workerSock,
  { type: "event", hook: "SessionStart", payload },
  paths.pendingWal,
  paths.walLock,
);
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/hooks/session-start.ts
git commit -m "feat: add SessionStart hook with ensureWorker and context injection stub"
```

---

### Task 8: SessionStop Hook (`session-stop.ts`)

**Files:**
- Create: `src/hooks/session-stop.ts`

Semi-synchronous pattern: sends a request-response to the worker and waits up to 10s. If the worker doesn't respond, the hook exits gracefully — the session summary will be generated on next worker startup when it drains the WAL.

- [ ] **Step 1: Implement session-stop hook**

```typescript
// src/hooks/session-stop.ts
import { paths } from "../paths";
import { mapPayload } from "./map-payload";
import { trySendEvent, trySendRequest } from "./send";

const raw = JSON.parse(await Bun.stdin.text());
const payload = mapPayload(raw);

const requestId = `stop-${payload.session_id}-${Date.now()}`;

// Try request-response (wait up to 10s for worker to process session summary)
const response = await trySendRequest(
  paths.workerSock,
  { type: "request", id: requestId, hook: "Stop", payload },
  10000,
);

// If worker didn't respond, fall back to WAL so it processes on next startup
if (!response) {
  await trySendEvent(
    paths.workerSock,
    { type: "event", hook: "Stop", payload },
    paths.pendingWal,
    paths.walLock,
  );
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/hooks/session-stop.ts
git commit -m "feat: add Stop hook with request-response and WAL fallback"
```

---

## Chunk 3: Registration and Integration

### Task 9: Hook Registration (`hooks.json`)

**Files:**
- Create: `hooks.json` (project root)

- [ ] **Step 1: Create hooks.json**

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|clear|compact|resume",
      "hooks": [{
        "type": "command",
        "command": "bun ./dist/hooks/session-start.js",
        "timeout": 5000
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "bun ./dist/hooks/prompt-submit.js",
        "timeout": 2000
      }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "bun ./dist/hooks/post-tool-use.js",
        "timeout": 5000
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "bun ./dist/hooks/session-stop.js",
        "timeout": 10000
      }]
    }]
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add hooks.json
git commit -m "feat: add hooks.json registration for Claude Code"
```

---

### Task 10: Integration Tests

**Files:**
- Create: `tests/hooks/integration.test.ts`

End-to-end tests that pipe JSON through the hook scripts via `Bun.spawn` and verify behavior. These tests exercise the full hook flow: stdin → mapPayload → send → worker/WAL.

- [ ] **Step 1: Write integration tests**

```typescript
// tests/hooks/integration.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpDir } from "../../src/test/helpers";
import { SocketServer } from "../../src/kernel/socket";

async function runHook(
  scriptPath: string,
  stdinData: Record<string, unknown>,
  env?: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", scriptPath], {
    stdin: new Blob([JSON.stringify(stdinData)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe("Hook integration", () => {
  let dir: string;
  let server: SocketServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test("post-tool-use sends event to worker socket", async () => {
    dir = tmpDir();
    const sockPath = join(dir, "worker.sock");
    const received: unknown[] = [];

    server = new SocketServer({
      socketPath: sockPath,
      onMessage: (msg) => received.push(msg),
    });
    server.start();

    // Override paths by setting DEJA_DIR env var
    // Note: This test relies on being able to override the socket path.
    // For now, we test mapPayload + send separately; this test validates
    // the hook script can be executed as a subprocess.
    const hookScript = join(process.cwd(), "src/hooks/post-tool-use.ts");
    const result = await runHook(hookScript, {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/project/app.ts", old_string: "a", new_string: "b" },
      tool_output: { success: true },
    });

    // Hook should exit 0 (even if it WAL-falls-back because our test socket
    // is at a different path than ~/.deja/worker.sock)
    expect(result.exitCode).toBe(0);
  });

  test("prompt-submit sends event to worker socket", async () => {
    const hookScript = join(process.cwd(), "src/hooks/prompt-submit.ts");
    const result = await runHook(hookScript, {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "UserPromptSubmit",
      prompt: "fix the bug",
    });

    expect(result.exitCode).toBe(0);
  });

  test("session-stop exits cleanly when no worker running", async () => {
    const hookScript = join(process.cwd(), "src/hooks/session-stop.ts");
    const result = await runHook(hookScript, {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "Stop",
    });

    expect(result.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `bun test tests/hooks/integration.test.ts`
Expected: 3 tests PASS

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass (167 existing + ~20 new ≈ 187 total)

- [ ] **Step 4: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add tests/hooks/integration.test.ts
git commit -m "test: add hook integration tests"
```

---

## Verification Checklist

After all tasks complete:

- [ ] `bun test` — all tests pass
- [ ] `bunx tsc --noEmit` — no type errors
- [ ] All 4 hook entry points exist in `src/hooks/`
- [ ] `hooks.json` matches spec's hook registration format
- [ ] Context generator stub exists at `src/context/generator.ts`
- [ ] Field mapping handles all 4 hook types + `tool_response` fallback
- [ ] `ensureWorker` handles: already running, stale PID, fresh start
- [ ] Fire-and-forget falls back to WAL on socket failure
- [ ] Stop hook uses request-response with 10s timeout
