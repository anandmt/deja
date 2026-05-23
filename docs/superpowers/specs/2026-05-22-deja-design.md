# deja — Zero-Config Persistent Memory for Claude Code

> "Your agent never forgets."

## Overview

**deja** is a Claude Code plugin that gives AI agents persistent memory across sessions. Every file read, code edit, bash command, and decision is automatically captured, compressed locally, and injected into future sessions — so the agent starts each conversation with context from prior work.

**What makes deja different:**
- **Zero external services.** Everything lives in one SQLite file. No ChromaDB, no Redis, no API keys required. No background services to manage.
- **Zero configuration.** `npx deja install` and it works. No setup wizard, no provider selection, no tokens.
- **Local-first compression.** Heuristic extraction handles all observations at zero cost out of the box. Optional AST (tree-sitter) and LLM tiers for richer extraction.
- **Reliable IPC.** Unix domain socket (macOS/Linux) or TCP localhost (Windows) with write-ahead log failover — no data loss, no stdin timeouts.

### Dependency Tiers

deja is designed with progressive enhancement. The base tier has zero npm dependencies beyond bun:sqlite (built into the runtime). Optional tiers add capabilities at the cost of native dependencies:

| Tier | What it adds | Dependencies | Enable via |
|---|---|---|---|
| **Tier 0 (default)** | Heuristic extraction + FTS5 search | `@modelcontextprotocol/sdk` (MCP server) | `npx deja install` |
| **Tier 1: AST** | Structural code understanding via tree-sitter | `tree-sitter` + language grammars | `npx deja enable ast` |
| **Tier 2: Vectors** | Semantic re-ranking via sqlite-vec + local embeddings | `sqlite-vec` + `onnxruntime-node` + model file | `npx deja enable vectors` |
| **Tier 3: LLM** | Rich narrative compression for high-significance events | API key for chosen provider | `npx deja settings --llm claude` |

Tier 0 is the full product — not a degraded mode. Every tier above it is additive.

## Competitive Context

| Feature | deja | claude-mem | memsearch |
|---|---|---|---|
| External services required | None | ChromaDB + AI provider | Milvus/Zilliz |
| Setup | `npx install`, done | API key + ChromaDB config | Milvus setup |
| Storage | Single .db file | SQLite + Chroma directory | Markdown files |
| Vector search | sqlite-vec (opt-in, embedded) | ChromaDB (external, required) | Milvus (external) |
| AI cost (default) | $0 (heuristic extraction) | Per-observation API calls | Per-observation API calls |
| IPC | Unix socket / TCP + WAL failover | stdin pipe (5s timeout) | N/A |
| Observation filtering | Significance classifier (30-40% skip) | None (stores everything equally) | Manual |
| Windows support | Yes (TCP localhost fallback) | Unreliable (Unix socket only) | Unknown |

## Architecture

### Micro-kernel + Pipelines

A thin kernel owns the SQLite database and Unix socket. Everything else is a pipeline stage — small, independent, pure functions that the kernel orchestrates.

```
Hook event → Queue → [Debounce] → [Classify] → [Normalize] → [Extract] → [Store + Index]
```

The debounce step batches events by session within a 100ms window (see Event Debouncing section). The classifier receives individual events annotated with batch context (e.g., "this event is part of a 3-edit batch"). Each pipeline stage after debounce: ~50-100 lines, pure function (input → output), zero side effects, independently testable with no mocking.

### System Overview

```
┌─────────────────────────────────────────────────────────┐
│                      CLAUDE CODE                         │
│  Hooks fire on: SessionStart, PostToolUse,               │
│  UserPromptSubmit, Stop                                  │
└──────────┬──────────────────────────────────────────────┘
           │ Unix domain socket (~/.deja/worker.sock)
           │ or TCP localhost (Windows)
           │ Fallback: write to ~/.deja/pending.wal
           ▼
┌─────────────────────────────────────────────────────────┐
│                    DEJA WORKER                            │
│                                                          │
│  Kernel: db.ts | socket.ts | wal.ts | timers.ts         │
│                                                          │
│  Pipelines:                                              │
│    Ingest:  classify.ts → normalize.ts                   │
│    Extract: ast.ts | heuristic.ts | llm.ts (opt-in)     │
│    Index:   fts.ts | vector.ts                           │
│    Search:  fts.ts → rerank.ts → hybrid.ts              │
│                                                          │
│  Context: generator.ts (SessionStart injection)          │
│  MCP: server.ts + tools.ts (in-session search)           │
└─────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────┐
│              ~/.deja/memory.db (SQLite)                   │
│                                                          │
│  Tables: observations, sessions, schema_version          │
│  Indexes: FTS5 (keyword), sqlite-vec (vector, optional)  │
│  All in one file. Portable. Backupable.                  │
└─────────────────────────────────────────────────────────┘
```

### Kernel Components

| Module | Responsibility |
|---|---|
| **`db.ts`** | Opens/closes SQLite, runs migrations, exposes `db.exec()` / `db.query()` wrappers with retry-on-SQLITE_BUSY |
| **`socket.ts`** | Creates Unix domain socket (or TCP listener on Windows), accepts connections, dispatches NDJSON messages to the event queue |
| **`wal.ts`** | Reads/writes `pending.wal` with lockfile protocol, drains WAL into the event queue on startup |
| **`timers.ts`** | Manages two timers: (1) **Idle timeout** — 30min inactivity timer, reset on each socket message, triggers clean shutdown on expiry. (2) **Debounce windows** — per-session 100ms fixed timers for event batching (see Event Debouncing section). Also runs **retention pruning** at worker startup if `settings.retention` is set. |

## Tech Stack

| Component | Technology | Tier | Why |
|---|---|---|---|
| Runtime | Bun (>= 1.3.6) | Required | Native SQLite bindings (bun:sqlite), fast startup |
| Language | TypeScript (strict) | Required | Largest contributor pool, Claude Code ecosystem |
| Database | SQLite via bun:sqlite | Tier 0 | Zero dependency, one file, ACID, built-in FTS5 |
| Keyword search | FTS5 (SQLite built-in) | Tier 0 | Zero dependency, porter stemming, BM25 ranking |
| AST parsing | tree-sitter | Tier 1 | Multi-language structural code understanding |
| Vector search | sqlite-vec | Tier 2 | Stays in the SQLite file, no external service |
| Embeddings | ONNX Runtime + all-MiniLM-L6-v2 | Tier 2 | Local, no API calls |
| IPC (macOS/Linux) | Unix domain socket | Tier 0 | Reliable, no timeouts, no data loss |
| IPC (Windows) | TCP localhost | Tier 0 | Cross-platform fallback (see Platform Support) |
| Tests | bun:test | Dev | Fast, built into runtime |
| Package | npm | Tier 0 | `npx deja install` |

### Platform Support

| Platform | IPC Transport | sqlite-vec | ONNX Runtime | Status |
|---|---|---|---|---|
| macOS (Apple Silicon) | Unix socket | Requires bundled SQLite dylib (see Tier 2 setup) | Supported | Full support |
| macOS (Intel) | Unix socket | Requires bundled SQLite dylib | Supported | Full support |
| Linux (x64) | Unix socket | Native extension loading | Supported | Full support |
| Windows | TCP localhost (127.0.0.1) | Native extension loading | Supported | Full support |

**macOS sqlite-vec note:** Apple's system SQLite disables extension loading. The `npx deja enable vectors` command handles this by downloading a compatible SQLite dylib and configuring `Database.setCustomSQLite()` automatically. Users do not need Homebrew or manual setup.

**Windows IPC note:** Unix domain sockets are unreliable on Windows. deja detects the platform at install time and configures TCP localhost as the transport. The port is fixed at `127.0.0.1:19532` (chosen to avoid common port ranges; the number spells "1-deja" on a phone keypad). The port is written to `~/.deja/settings.json` as `"tcp_port": 19532` and can be changed via `npx deja settings --tcp-port <N>` if there's a conflict. Hooks and the worker both read this setting. The WAL failover works identically on both transports.

**Windows file locking note:** The spec uses `flock()` for WAL writes and worker startup locking. On Windows, deja uses `LockFileEx` (via Bun's `fs` bindings or Node-compatible `proper-lockfile` package) for the same semantics. The locking module (`src/kernel/lock.ts`) exports a platform-agnostic `acquireLock(path)` / `releaseLock(fd)` interface that selects the right implementation at runtime.

### `npx deja enable ast` (Tier 1)

```
npx deja enable ast
  1. Check Bun version >= 1.3.6
  2. Install tree-sitter and default grammars:
     → bun add tree-sitter tree-sitter-javascript tree-sitter-typescript
       tree-sitter-python tree-sitter-go tree-sitter-rust
     → Installed into the deja package's node_modules (not the user's project)
  3. Smoke test: parse a small JS snippet to verify tree-sitter loads
     → If fails: print error, do not enable, exit 1
  4. Update settings.json: tiers.ast = true
  5. Print: "AST extraction enabled. Languages: JS, TS, Python, Go, Rust."
     → "Add more: npx deja enable ast --lang java,cpp"
```

**Adding language grammars:** `npx deja enable ast --lang java,cpp` installs additional tree-sitter grammars. The grammar package names follow the `tree-sitter-<lang>` convention. If a grammar package doesn't exist for a requested language, the command prints a warning and skips it.

**Disabling:** `npx deja disable ast` sets `tiers.ast = false` in settings.json and prints confirmation. The tree-sitter packages are NOT uninstalled (to avoid slow reinstalls if the user re-enables). The AST extractor simply isn't called when the tier is disabled.

### `npx deja enable vectors` (Tier 2)

```
npx deja enable vectors
  1. Check Bun version >= 1.3.6
  2. Install native dependencies:
     → bun add sqlite-vec onnxruntime-node
  3. Download embedding model:
     → Fetch all-MiniLM-L6-v2 ONNX model (~80MB) to ~/.deja/models/
     → Print progress: "Downloading model... 45/80 MB"
  4. macOS sqlite-vec setup:
     → Download compatible SQLite dylib (~2MB) to ~/.deja/lib/
     → Configure Database.setCustomSQLite() path in settings
  5. Smoke test: load model, embed "test query", verify vector dimensions (384)
     → If fails: print error, undo settings change, exit 1
  6. Backfill prompt:
     → "Found 1,247 observations without embeddings. Generate now? (y/N)"
     → Yes: batch-generate embeddings for all existing observations (~30s for 1000)
     → No: "Embeddings will be generated for new observations only."
  7. Update settings.json: tiers.vectors = true
  8. Print: "Vector search enabled. Model: all-MiniLM-L6-v2 (384 dimensions)"
```

**Disabling:** `npx deja disable vectors` sets `tiers.vectors = false`. Existing embeddings in the DB are preserved (cost nothing when unused). The model file (~80MB) is NOT deleted (use `npx deja disable vectors --purge` to also remove `~/.deja/models/`).

### ONNX Runtime Compatibility

ONNX Runtime under Bun requires Bun >= 1.3.6. The `npx deja enable vectors` command validates the Bun version and runs a model-loading smoke test before enabling. If the smoke test fails, it reports the error and leaves Tier 0 (FTS5-only) active.

## Data Model

### SQLite Schema (`~/.deja/memory.db`)

```sql
-- Enable WAL mode for concurrent read/write (search while writing observations)
PRAGMA journal_mode=WAL;
-- Foreign keys are intentionally NOT enforced (PRAGMA foreign_keys remains OFF).
-- Reason: During WAL drain, PostToolUse events may arrive before the SessionStart
-- event that creates the session row (if hooks fired in rapid succession before worker
-- started). The pipeline ensures ordering by processing events sequentially from the
-- queue, but defensive coding means the schema tolerates out-of-order inserts.
-- The session_id REFERENCES declaration serves as documentation, not a constraint.

CREATE TABLE observations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  project         TEXT NOT NULL,

  -- Classified significance: skip | low | medium | high | critical
  significance    TEXT NOT NULL DEFAULT 'medium',

  -- Structured extraction
  kind            TEXT NOT NULL,     -- file_read, file_edit, file_write, bash_cmd, decision, prompt
  title           TEXT NOT NULL,     -- one-line: "Modified IBKRClient.place_order"
  content         TEXT NOT NULL,     -- full observation narrative
  facts           TEXT,              -- JSON array of extracted atomic facts
  concepts        TEXT,              -- JSON array: ["order-management", "rate-limiting"]

  -- File tracking
  files_read      TEXT,              -- JSON array of file paths
  files_modified  TEXT,              -- JSON array of file paths

  -- Raw event for future reprocessing
  raw_event       TEXT NOT NULL,     -- original hook JSON payload

  -- Embeddings (nullable — only when Tier 2 vectors is active)
  embedding       BLOB,             -- float32 vector

  created_at_epoch INTEGER NOT NULL  -- Unix epoch ms, single source of truth
);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY, -- Claude Code's session_id from hook input
  project           TEXT NOT NULL,
  started_at_epoch  INTEGER NOT NULL,
  ended_at_epoch    INTEGER,
  summary           TEXT,
  summary_embedding BLOB
);

-- Full-text search
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title, content, facts, concepts,
  content='observations',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Keep FTS in sync: INSERT, UPDATE, and DELETE
CREATE TRIGGER obs_fts_insert AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, content, facts, concepts)
  VALUES (new.id, new.title, new.content, new.facts, new.concepts);
END;

CREATE TRIGGER obs_fts_update AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, facts, concepts)
  VALUES ('delete', old.id, old.title, old.content, old.facts, old.concepts);
  INSERT INTO observations_fts(rowid, title, content, facts, concepts)
  VALUES (new.id, new.title, new.content, new.facts, new.concepts);
END;

CREATE TRIGGER obs_fts_delete AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, facts, concepts)
  VALUES ('delete', old.id, old.title, old.content, old.facts, old.concepts);
END;

-- Indexes
CREATE INDEX idx_obs_project ON observations(project);
CREATE INDEX idx_obs_session ON observations(session_id);
CREATE INDEX idx_obs_significance ON observations(significance);
CREATE INDEX idx_obs_kind ON observations(kind);
CREATE INDEX idx_obs_created ON observations(created_at_epoch);

-- Lightweight counters for stats (no per-event rows for skipped events)
CREATE TABLE stats (
  project     TEXT NOT NULL,
  metric      TEXT NOT NULL,     -- "events_skipped", "events_processed", "context_injections", "context_chars_total"
  value       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project, metric)
);

-- Schema versioning
CREATE TABLE schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL  -- epoch ms
);
```

### Key Design Decisions

1. **`significance` field** — Classifier tags every event. `skip` events never get stored (30-40% of all events). Avoids storing noise.
2. **`raw_event` column** — Pragmatic event sourcing. If we improve extractors in v2, re-process old events without losing history.
3. **`embedding` as nullable BLOB** — sqlite-vec stores vectors as raw float32 blobs. NULL when vector search isn't active. Costs nothing when unused.
4. **`facts` as JSON array** — Atomic, searchable facts for precise retrieval without reading full narratives.
5. **Porter stemming on FTS5** — "connecting" matches "connection", "connected". Better recall for code queries.
6. **No auto-pruning by default** — Storage is negligible (~250MB/year at heavy use). Users can opt into retention via settings. "Never forgets" means never forgets. When retention IS enabled (`--retention 90d`): pruning runs at worker startup, deletes observations with significance `low` or `medium` older than the threshold. `high` and `critical` observations are **never pruned** regardless of age — architectural decisions and important discoveries persist forever. Session rows are cleaned up if all their observations are deleted. If some observations remain in a session after pruning, the session summary is **regenerated using the Tier 0 heuristic** (top 5 remaining observation titles, same logic as the Stop hook's non-LLM path) — regardless of what tier originally created the summary. This avoids requiring an LLM call during a maintenance operation and keeps pruning deterministic.
7. **WAL journal mode** — Enables concurrent reads and writes. Search queries don't block observation writes. Critical for a system where the worker writes continuously while MCP tools read.
8. **Epoch-only timestamps** — Single source of truth as integer. Human-readable dates derived via `datetime(epoch/1000, 'unixepoch')` when needed. Avoids redundant columns.
9. **FTS triggers for INSERT, UPDATE, and DELETE** — Full sync coverage. Prevents phantom search results when observations are updated (re-extraction) or deleted (retention pruning).
10. **Session ID from Claude Code** — `sessions.id` uses Claude Code's own `session_id` from hook input, not a self-generated UUID. This ensures hook events correlate to sessions without additional mapping.
11. **Project identity is the working directory path** — The `project` field stores the absolute filesystem path of the working directory (from the hook's `cwd`). This is the simplest correct answer: Claude Code hooks already provide `cwd`, and it matches how users think about projects ("the folder I'm in"). The tradeoff is that the same repo cloned to two paths is treated as two projects. This is intentional — different clones may be at different states (branches, local changes), so sharing memory could be misleading. Users who want to merge them can use `npx deja export` + `npx deja import`.

## Worker Lifecycle

The deja worker is a long-running Bun process that handles all observation processing, indexing, and search.

### Startup

The worker is started **lazily on first hook fire**, not at install time or system boot.

```
SessionStart hook fires
  → Check worker.pid exists?
    → Yes: read PID, verify process alive via kill(pid, 0)
      → Alive: try connecting to worker.sock (100ms timeout)
        → Connected: send payload
        → Connection refused/timeout: stale socket — proceed to respawn
      → Dead: stale PID file — proceed to respawn
    → No: proceed to respawn
  → Respawn:
    → Acquire lockfile (~/.deja/worker.lock) via flock (prevents race between concurrent hooks)
    → Re-check worker.pid (another hook may have won the race)
    → Remove stale worker.sock and worker.pid if present
    → Spawn worker process (detached, background)
    → Worker creates worker.sock (or TCP listener on Windows)
    → Worker drains pending.wal if non-empty
    → Worker writes PID to ~/.deja/worker.pid
    → Release lockfile
    → Hook retries connection (max 10 attempts, 200ms apart, 2s total)
    → First SessionStart may go to WAL if worker is still booting — context injection
      reads the DB directly, so it works even without the worker
```

### Shutdown

The worker shuts down after an **idle timeout of 30 minutes** (no hook events received). This avoids leaving a background process running when the user isn't using Claude Code.

```
Last hook event received
  → Start 30-minute idle timer
  → New hook event → reset timer
  → Timer expires → worker exits cleanly
      → Removes worker.sock
      → Removes worker.pid
```

### Multi-Session Concurrency

Multiple Claude Code sessions share **one worker process**. This is safe because:

1. SQLite WAL mode allows concurrent reads and writes.
2. Each observation is tagged with its `session_id` — no cross-session pollution.
3. The worker processes events sequentially from a single queue — no race conditions.
4. If 5 Claude Code sessions are open simultaneously, all 5 send events to the same worker socket, and the worker processes them in arrival order.

### Worker Queue

The worker maintains an **unbounded in-memory array** as its event queue. Events arrive from the socket listener and are pushed to the queue. A single processing loop pulls events one at a time (or in debounced batches) and runs them through the pipeline.

**Processing time per event:**
- Tier 0 (heuristic): ~5-10ms (regex, string ops, SQLite insert)
- Tier 1 (AST): ~50-100ms (tree-sitter parse + SQLite insert)
- Tier 3 (LLM): ~500-2000ms (API call, network bound)

**Backpressure policy: none (by design).** The queue is unbounded because:
- Events are small (~2-5KB each). Even 1000 queued events is ~5MB of memory.
- The queue drains faster than it fills in all realistic scenarios. A heavy session generates ~200 events over 30+ minutes. `deja learn` generates 500 events in ~5 seconds — at Tier 0 processing speed (10ms/event), the queue drains in 5 seconds. At Tier 1 speed (100ms/event), 50 seconds. Both are acceptable.
- The alternative (bounded queue + drop policy) adds complexity and data loss for a scenario that never causes memory issues in practice.

**Memory safety check:** On each queue push, if `queue.length > 5000`, log a warning: "Event queue depth exceeds 5000. Processing may be behind." This is a monitoring signal, not a flow control mechanism. At 5KB per event, 5000 events = ~25MB — well within reason. If the queue ever reaches this depth, the real problem is the worker's processing loop, not the queue.

### IPC Wire Protocol

Hooks communicate with the worker via **newline-delimited JSON (NDJSON)** over the Unix socket (or TCP on Windows). Two message patterns:

**Fire-and-forget** (PostToolUse, UserPromptSubmit):
```
→ {"type":"event","hook":"PostToolUse","payload":{...}}\n
```
No response expected. The worker acknowledges receipt internally but sends nothing back.

**Request-response** (Stop hook, for session summary wait):
```
→ {"type":"request","id":"<uuid>","hook":"Stop","payload":{...}}\n
← {"type":"response","id":"<uuid>","status":"ok"}\n
```
The Stop hook waits for the response (up to 10s timeout). The `id` field correlates request to response.

**SessionStart does NOT use the socket for context injection** — it reads the DB directly (see Hook Entry Points below). It sends a fire-and-forget event to the worker for observation capture only.

Message framing: each message is a complete JSON object on a single line, terminated by `\n`. The receiver reads line-by-line (buffered by newline). Maximum message size: 1MB (payloads approaching this indicate a bug — normalized content is capped at 2000 chars).

### Hook Entry Points

Each Claude Code hook is a **thin shim** (~20 lines). Most hooks (PostToolUse, UserPromptSubmit) are fire-and-forget:
1. Serialize the hook payload to JSON
2. Send it to the worker via socket (or append to WAL on failure)
3. Return immediately (< 50ms)

All heavy work (classification, extraction, indexing) happens asynchronously in the worker. **Any socket error (connect refused, broken pipe, write timeout) triggers WAL fallback** — the hook writes the event to `pending.wal` and returns. No distinction between "worker down" and "worker flaky."

**Exception: SessionStart is synchronous request-response.** It must return context injection data to Claude Code. The flow:

```
SessionStart hook fires
  → Open memory.db with WRITE access (not read-only — it must increment stats counters)
  → Query: last session summary + top observations + cross-project insights
  → Format as <system-reminder> block (within token budget)
  → Increment stats: context_injections +1, context_chars_total +chars (via upsert)
  → Return context to Claude Code
  → ALSO send the SessionStart event to the worker via socket (fire-and-forget)
```

The SessionStart hook does NOT go through the worker for context generation — it reads the DB directly, keeping latency under 200ms (SQLite FTS5 queries are <5ms on typical databases). The 5000ms hook timeout provides ample headroom. This means the hook shim for SessionStart is slightly heavier than other hooks (~50 lines), but it avoids the need for a synchronous request-response protocol on the worker socket.

**Exception: Stop is semi-synchronous.** It sends the session-end event to the worker and waits up to 10s for acknowledgment (so the worker can generate the session summary before Claude Code exits). If the worker doesn't respond within 10s, the hook returns — the summary will be generated on the next worker startup when it drains the WAL.

### Hook Payload Shapes

Claude Code hooks receive JSON on stdin. Each hook type has a different shape. The fields below are what deja's pipeline depends on — other fields may be present but are ignored.

**SessionStart:**
```json
{
  "type": "SessionStart",
  "session_id": "abc123-def456",
  "cwd": "/Users/alice/projects/my-app",
  "trigger": "startup"  // "startup" | "clear" | "compact"
}
```
Pipeline uses: `session_id` (creates session row), `cwd` (project identity), `trigger` (classification: compact → skip).

**UserPromptSubmit:**
```json
{
  "type": "UserPromptSubmit",
  "session_id": "abc123-def456",
  "cwd": "/Users/alice/projects/my-app",
  "prompt": "Fix the rate limiting bug in client.py"
}
```
Pipeline uses: `prompt` (classifier checks for decision-like language: "let's use X", "switch to Y").

**PostToolUse:**
```json
{
  "type": "PostToolUse",
  "session_id": "abc123-def456",
  "cwd": "/Users/alice/projects/my-app",
  "tool": "Edit",
  "input": {
    "file_path": "/Users/alice/projects/my-app/src/client.py",
    "old_string": "def connect(self):",
    "new_string": "def connect(self, timeout: int = 30):"
  },
  "output": {
    "success": true
  }
}
```
For **Edit**: `input.old_string` and `input.new_string` ARE the diff. The heuristic extractor runs regex on these to extract function names. No unified diff needed.

For **Write**: Content being written is in `input.content`. The `output` is just success/failure — it does NOT echo the content back.
```json
{
  "type": "PostToolUse",
  "tool": "Write",
  "input": { "file_path": "/Users/alice/projects/my-app/src/new-module.ts", "content": "export class NewModule { ... }" },
  "output": { "success": true }
}
```

For **Read**: File content is in `output` (the result of reading the file).
```json
{
  "type": "PostToolUse",
  "tool": "Read",
  "input": { "file_path": "/Users/alice/projects/my-app/src/client.py" },
  "output": { "content": "import asyncio\n\nclass IBKRClient:\n    ..." }
}
```

For **Bash**: `output.stdout` and `output.stderr` contain command results. `input.command` has the command string.
```json
{
  "type": "PostToolUse",
  "tool": "Bash",
  "input": { "command": "pytest tests/ -v" },
  "output": {
    "stdout": "...42 passed, 3 failed...",
    "stderr": "",
    "exit_code": 1
  }
}
```

**Stop:**
```json
{
  "type": "Stop",
  "session_id": "abc123-def456",
  "cwd": "/Users/alice/projects/my-app"
}
```

**Important: These shapes are based on Claude Code's current hook API (May 2026).** If Claude Code changes its payload format, the normalize stage is the single point of adaptation — other pipeline stages work on normalized output, not raw payloads.

## Plugin Registration

### Plugin Manifest (`plugin.json`)

```json
{
  "name": "deja",
  "version": "0.1.0",
  "description": "Zero-config persistent memory for Claude Code",
  "homepage": "https://github.com/<org>/deja",
  "hooks": "./hooks.json",
  "mcp": "./.mcp.json"
}
```

### Hook Registrations (`hooks.json`)

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|clear|compact",
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

### Hook Execution Cost

Each hook invocation spawns a fresh Bun process (`bun ./dist/hooks/*.js`). Bun cold start is ~25ms + socket connect ~5ms + serialize/send ~2ms = **~32ms per hook invocation**. For PostToolUse matching `*`, every tool use pays this cost.

**Why this is acceptable for v1:**
- 32ms is well under the 2000ms hook timeout — Claude Code doesn't notice.
- The overhead is wall-clock time in a subprocess, not blocking Claude Code's main loop.
- A heavy session with 200 tool uses adds ~6.4s of cumulative subprocess time, spread over the session.

**Future optimization (v2): persistent hook shim.** Instead of spawning a Bun process per hook, a tiny long-running shim process could listen on a second Unix socket (or the worker itself could accept hook payloads directly). The hook command would become a ~5-line shell script or compiled binary that just pipes stdin to the socket. This would reduce per-hook cost from ~32ms to ~2ms. Deferred to v2 because: (a) the current approach works correctly, (b) the overhead is invisible to users, and (c) adding another long-running process adds complexity to install/uninstall.

**No PreToolUse hook:** deja does NOT register a PreToolUse hook. PreToolUse fires *before* the tool runs and captures only intent ("about to read file X"). PostToolUse fires *after* and captures the full result — the same file path plus the actual output. Registering both would pay ~32ms per invocation (Bun process spawn + socket connect) for events the classifier would immediately discard. PostToolUse with `*` matcher captures everything PreToolUse would, plus the result. Net saving: ~6.4s of subprocess time per 200-tool-use session.

### MCP Server Registration (`.mcp.json`)

```json
{
  "mcpServers": {
    "deja": {
      "type": "stdio",
      "command": "bun",
      "args": ["./dist/mcp/server.js"]
    }
  }
}
```

### MCP Server ↔ Worker Relationship

The MCP server runs as a **separate stdio process** (spawned by Claude Code) that reads `memory.db` **directly** — it does NOT route through the worker's Unix socket.

This is safe because:
1. SQLite WAL mode supports concurrent readers. The MCP server opens the database in `SQLITE_OPEN_READONLY` mode.
2. The MCP server only needs read access (search, timeline, observe, summary). All writes go through the worker via hooks.
3. A direct DB read is faster and simpler than proxying through the worker socket.

The system overview diagram shows MCP tools logically within the worker box for simplicity, but the actual process boundary is: **hooks → worker (writes)**, **MCP server → SQLite (reads)**. The worker and MCP server never communicate with each other directly.

### Database Access Modes

Multiple processes access `memory.db`. All concurrent access is safe under WAL journal mode, but each process must open with the correct mode:

| Process | Access Mode | What it writes |
|---|---|---|
| **Worker** | Read-write | Observations, sessions, FTS index (via triggers), stats (`events_skipped`, `events_processed`) |
| **SessionStart hook** | Read-write | Stats only (`context_injections`, `context_chars_total` via upsert) |
| **MCP server** | `SQLITE_OPEN_READONLY` | Nothing — read-only search and timeline queries |
| **Dashboard** | `SQLITE_OPEN_READONLY` | Nothing — read-only API queries |
| **CLI commands** (search, sessions, replay, diff, stats) | `SQLITE_OPEN_READONLY` | Nothing — read-only |
| **CLI commands** (learn, compact, forget, import) | Read-write | learn: session row + summary. compact: VACUUM. forget: DELETE. import: INSERT. |

The SessionStart hook is the only hook shim that opens the DB directly with write access. All other hooks are fire-and-forget through the socket; they never touch the DB.

## Pipeline Flow

### Hook → Observation → Index

#### Stage 1: Classify (`pipelines/ingest/classify.ts`)

Determines if the event is worth storing. This is the cost-saver — 30-40% of events are skipped.

```
Input:  Raw hook payload + session state (recent events for dedup)
Output: { significance: "skip" | "low" | "medium" | "high" | "critical" }
```

**Classification rules (evaluated top-to-bottom, first match wins):**

| Significance | Condition | Implementation |
|---|---|---|
| **SKIP** | Excluded project | `cwd` matches any prefix in `settings.excluded_projects` |
| **SKIP** | Noise file read | `tool=Read` AND path matches: `node_modules/**`, `.git/**`, `*-lock.json`, `*.lock`, `dist/**`, `build/**`, `.next/**` |
| **SKIP** | Noise file extension | `tool=Read` AND path ends with: `.map`, `.min.js`, `.min.css` |
| **SKIP** | Duplicate bash command | `tool=Bash` AND same `input.command` string seen in this session within last 60s (tracked via in-memory set per session_id, cleared on session end) |
| **SKIP** | Navigation commands | `tool=Bash` AND `input.command` matches: `^(ls\|pwd\|cd\|echo \$\|which\|type\|cat <<<)` |
| **SKIP** | Credential files | Path matches: `.env*`, `*.pem`, `*.key`, `credentials.*`, `*secret*` |
| **CRITICAL** | New source file created | `tool=Write` AND path under `src/`, `lib/`, `app/`, or project root AND file is new — detected by tracking an in-memory set of Write paths per session; the first Write to a given path in a session is treated as a creation. (Claude Code's PostToolUse payload for Write does not include a `created` flag, so this is the only reliable method.) |
| **CRITICAL** | Dependency file changed | `tool=Edit` AND path matches: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `requirements.txt`, `Gemfile` |
| **CRITICAL** | Decision in prompt | `hook=UserPromptSubmit` AND prompt matches decision patterns: `let's use`, `switch to`, `we should`, `decided to`, `choosing`, `going with` (case-insensitive) |
| **HIGH** | Multi-file edit batch | Debounce batch contains ≥ 2 Edit/Write events for different files (the debouncer sets this flag, not the classifier — the classifier reads it) |
| **HIGH** | Test failure | `tool=Bash` AND `output.exit_code != 0` AND (`input.command` matches `pytest\|jest\|vitest\|cargo test\|go test\|npm test\|bun test` OR `output.stdout` matches `failed\|FAIL\|error`) |
| **HIGH** | Error debugging | `tool=Bash` AND `output.stderr` length > 200 chars AND `output.exit_code != 0` |
| **LOW** | Config file read | `tool=Read` AND path matches: `*.json`, `*.yaml`, `*.yml`, `*.toml`, `*.ini`, `*.cfg` (but NOT dependency files — those are CRITICAL when edited) |
| **LOW** | Simple grep/find | `tool=Bash` AND `input.command` matches `^(grep\|find\|rg\|ag\|fd) ` AND output length < 500 chars |
| **MEDIUM** | Everything else | Default for any event not matching above rules |

#### Stage 2: Normalize (`pipelines/ingest/normalize.ts`)

Cleans raw payload into a consistent shape for the extract stage. Each hook type produces a different `content_summary`.

```
Input:  Raw hook payload + classification
Output: { tool, files, action, content_summary (max 2000 chars), raw_event }
```

**`content_summary` construction per hook type:**

| Hook / Tool | Content | Truncation |
|---|---|---|
| **PostToolUse / Edit** | `"EDIT {file_path}\n--- old\n{old_string}\n+++ new\n{new_string}"` | Truncate `old_string` and `new_string` to 900 chars each (total ≤ 2000 with framing) |
| **PostToolUse / Write** | `"WRITE {file_path}\n{first 2000 chars of input.content}"` | First 2000 chars of new file content (content is in `input`, not `output` — the Write tool's output is just `{ success: true }`) |
| **PostToolUse / Read** | `"READ {file_path}\n{first 2000 chars of output.content}"` | First 2000 chars — enough for docstrings, imports, structure |
| **PostToolUse / Bash** | `"BASH $ {command}\n{stdout}\n{stderr}"` | `command` uncapped; `stdout` + `stderr` truncated to fill remaining budget (stdout prioritized) |
| **UserPromptSubmit** | `"PROMPT {prompt}"` | First 2000 chars of prompt text |
| **SessionStart** | `"SESSION_START project={cwd} trigger={trigger}"` | No truncation needed (always short) |
| **Stop** | `"SESSION_END project={cwd}"` | No truncation needed |

Truncation always cuts at the last complete line before the limit (never mid-line). If the content is under 2000 chars, no truncation occurs.

#### Stage 3: Extract (`pipelines/extract/*.ts`)

Generates the structured observation. Three extractors, matching the dependency tiers:

- **Heuristic Extractor** (Tier 0, always available, zero cost): Extracts meaningful observations from raw hook data using pattern matching and lightweight analysis. Smarter than raw diffs — not just "what changed" but structured understanding:

  **For file edits (Edit):** Extracts function/class names from diff context lines using simple regex (matches `def `, `function `, `class `, `const `, `export ` patterns across Python/JS/TS/Go/Rust). Title becomes `"Modified ConnectionManager.reconnect()"` not just `"Edited connection.py"`. Detects import additions, deletions, and signature changes.

  **For file writes (Write):** Sets `kind=file_write`. Title format: `"Created {filename}"` for new files, `"Rewrote {filename}"` if the file previously existed (detected by checking `files_modified` in earlier observations from the same session for the same path). Facts are extracted from the content: first docstring/comment block (if present), detected imports/dependencies, and any class/function names found via the same regex patterns as file edits. Concepts follow the same file-path extraction as edits. Since Write events carry full file content (up to the 2000-char normalizer cap), the extractor has richer signal than Edit events for new files.

  **For bash output:** Recognizes test runners (pytest, jest, vitest, cargo test) and extracts pass/fail counts. Detects error patterns (stack traces, exit codes). Recognizes git operations (commit messages, branch switches, merge conflicts). Title becomes `"Tests: 42 passed, 3 failed (test_orders.py)"` not `"Ran bash command"`.

  **For file reads:** Groups sequential reads of related files (same directory, same module) into a single "explored module X" observation. Extracts the file's purpose from its first docstring/comment block if present.

  **For user prompts (UserPromptSubmit):** Extracts decision intent from the prompt text. If the classifier tagged it CRITICAL (matches decision patterns like "let's use X", "switch to Y"), the extractor sets `kind=decision`, title = `"Decision: {first 80 chars of prompt}"`, content = full normalized prompt text, and facts = the matched decision phrases. If not CRITICAL (medium/low), `kind=prompt`, title = `"Prompt: {first 80 chars}"`. Concepts are extracted by scanning the prompt for known project file names and technical terms (same normalization as file path concepts).

  **For SessionStart/Stop:** These events are NOT stored as observations. SessionStart creates the session row (via worker) and generates context injection (via direct DB read). Stop triggers session summary generation (via worker). Neither produces an observation in the `observations` table — they are session lifecycle events, not observations. The classifier still processes them (to SKIP compact triggers, and to route Stop to the summary flow), but the pipeline short-circuits after classification for these event types.

  **Concept extraction (Tier 0):** Derives concepts from file paths and detected patterns. Not as rich as LLM concepts, but enough for cross-session matching.

  **Algorithm:**
  1. **From file paths:** Split path on `/` and `.`. Drop the extension (`.py`, `.ts`, `.go`, etc.). Drop stopword segments: `src`, `lib`, `app`, `dist`, `build`, `index`, `main`, `test`, `tests`, `spec`, `__pycache__`, `node_modules`. Keep remaining segments. Example: `src/tools/trading.py` → split to `[src, tools, trading, py]` → drop `src`, `py` → `["tools", "trading"]`.
  2. **From bash patterns:** Match against known pattern categories. Test runners (`pytest`, `jest`, etc.) → add `"testing"`. Test failure (`exit_code != 0` + test runner) → add `"testing"`, `"failure"`. Git commands → add `"git"` + subcommand (`"git-commit"`, `"git-merge"`). Build commands (`npm run build`, `cargo build`) → add `"build"`.
  3. **From edit content:** If the heuristic extractor detects a function/class name, add it as a concept: `"ConnectionManager"` → `"connection-manager"` (camelCase/PascalCase split to kebab-case).
  4. **Normalize all concepts:** Lowercase, split camelCase/PascalCase on boundaries, collapse underscores/spaces/hyphens to single hyphens. `"Rate_Limiting"` → `"rate-limiting"`. `"ConnectionManager"` → `"connection-manager"`. Dedup the final array.
  5. **Cap at 5 concepts per observation.** If more than 5, keep the 5 most specific (longest strings — longer strings tend to be more meaningful than single-word generics).
- **AST Extractor** (Tier 1, opt-in): tree-sitter parses the file → extracts function signatures, class names, imports, structural changes. Richer facts and concepts than heuristic.
- **LLM Extractor** (Tier 3, opt-in): Sends normalized event to configured model. Gets rich narrative, intent understanding, relationships. Falls back to heuristic on failure.

```
Tier 0 only:    all events → Heuristic Extractor
Tier 1 enabled: file events → AST Extractor, bash events → Heuristic Extractor
Tier 3 enabled: high/critical → LLM Extractor, rest → best available (AST or heuristic)
```

#### Stage 4: Store + Index (`kernel/db.ts` + `pipelines/index/*.ts`)

```
Observation → INSERT into observations table
           → FTS5 trigger fires automatically
           → If sqlite-vec: generate local embedding → store in embedding column
```

### Session End Flow

```
Stop hook fires
  → Gather all observations from this session
  → If LLM enabled: generate session summary via LLM
  → If LLM disabled: build summary from top 5 observation titles (prefer high/critical,
      fall back to medium if fewer than 5 high/critical exist, never include low).
      Format: "Session covered: <title1>, <title2>, ..."
      Max length: 500 characters. Truncated at last complete title if over budget.
      If zero qualifying observations: summary = "Short session with no significant observations."
  → Store summary in sessions table
```

## Search & Context Injection

### Search Pipeline

```
Query
  │
  ▼
FTS5 Query (porter stemming applied by tokenizer)
  │
  ▼
FTS5 Candidate Retrieval (BM25 ranked, top 100, < 5ms)
  │
  ├── sqlite-vec disabled → return top 100 as-is
  │
  └── sqlite-vec enabled:
      Vector Re-ranking (embed query via local ONNX, cosine similarity)
      │
      ▼
      Normalize scores to [0, 1]:
        FTS:     rank_normalized = 1 - (rank / candidate_count)  [rank 1 = 1.0, rank 100 = 0.0]
        Vector:  cosine_similarity is already [0, 1]
        Recency: exp(-age_days / 90)  [today = 1.0, 90 days ago = 0.37, 1 year = 0.017]
      │
      ▼
      Combined: 0.6 × rank_normalized + 0.3 × cosine_similarity + 0.1 × recency_score
      │
      ▼
      Top 20 results
```

### MCP Tools (3-Layer Protocol)

**`deja_search`** — Lightweight index. Always the first call.

```
Input:  { query: string, project?: string, significance?: "low"|"medium"|"high"|"critical",
          kind?: string, limit?: number (default 20, max 50) }
Output: { results: [{ id: number, title: string, significance: string,
          kind: string, created_at_epoch: number }], total_count: number }
```

**`deja_timeline`** — Chronological context around an anchor observation. **Same session only** — returns observations from the anchor's session, not across sessions. Use `deja_search` for cross-session queries.

```
Input:  { anchor: number (observation ID), before?: number (default 3), after?: number (default 3) }
Output: { observations: [{ id: number, title: string, significance: string,
          kind: string, created_at_epoch: number }], anchor_index: number }
```
Returns lightweight fields (same as search results). Window: `before` + 1 + `after` observations from the same session, ordered chronologically.

**`deja_observe`** — Full observation details. HARD CAP: max 10 IDs per request.

```
Input:  { ids: number[] (max 10) }
Output: { observations: [{ id: number, session_id: string, project: string,
          significance: string, kind: string, title: string, content: string,
          facts: string[], concepts: string[], files_read: string[],
          files_modified: string[], created_at_epoch: number }] }
```
The 10-ID hard cap prevents context window blowout — a gap in claude-mem. Requesting >10 IDs returns an error, not a truncated result.

**`deja_summary`** — Session summaries for a project/time range.

```
Input:  { project?: string, since_days?: number (default 30), limit?: number (default 10) }
Output: { sessions: [{ id: string, project: string, started_at_epoch: number,
          ended_at_epoch: number, summary: string, observation_count: number }] }
```
Returns sessions newest first. Each includes the summary text and observation count for context sizing.

### Context Injection (SessionStart)

```
SessionStart hook fires
  │
  ▼
Identify project (working directory)
  │
  ▼
Context Builder:
  1. Last session summary for this project
  2. Top 10 high-significance observations (by significance + recency)
  3. Cross-project insights (matched by shared concepts)
  │
  ▼
Format as <system-reminder> block
Budget: max 8000 characters (~2000 tokens) — configurable
  │
  ▼
Return to Claude Code for injection
```

First session (zero observations) → inject nothing, just start collecting.

### Injected Context Format

The exact output that Claude Code's agent sees at session start. This is the core value proposition — it must be dense, scannable, and actionable.

```xml
<system-reminder>
# deja — project memory for /Users/alice/projects/ibkr-mcp-server

## Last session (May 22, 10:15 PM — 11:42 PM)
Designed deja persistent memory plugin. Chose micro-kernel + pipeline architecture,
single SQLite file, heuristic-first extraction. Wrote full design spec.

## Key observations (most recent, highest significance first)
- [#247] CRITICAL: Wrote design spec — chose micro-kernel + pipeline architecture,
  single SQLite file, dependency tier system (Tier 0-3)
- [#245] HIGH: Added SQLite schema with FTS5 triggers for INSERT, UPDATE, DELETE.
  Porter stemming enabled. WAL mode for concurrent access.
- [#241] HIGH: Compared sqlite-vec vs LanceDB — chose sqlite-vec as optional
  re-ranker. FTS5 primary, vector secondary. Can rip out vectors without breaking core.
- [#238] HIGH: Analyzed claude-mem gaps — fragile stdin IPC (5s timeout), ChromaDB
  dependency, no observation filtering, 0 observations due to API key error.
- [#233] MEDIUM: Explored claude-mem worker-service.cjs — bundled JS, stdin pipe IPC,
  ChromaDB for vectors, SQLite for metadata.

## Cross-project (ibkr-mcp-server ↔ trading-bot)
- [#89/trading-bot] CRITICAL: IBKR API rate limit is 50 req/s, not 100 as documented.

Use deja_search/deja_timeline/deja_observe MCP tools for deeper memory access.
</system-reminder>
```

**Format rules:**
- Observation IDs (`[#247]`) are included so the agent can follow up with `deja_observe(ids=[247])` if it needs full details.
- Cross-project observations show `[#id/project-name]` to distinguish their origin.
- Each observation is one line: `[#id] SIGNIFICANCE: title — key facts condensed to ~150 chars`.
- The "Use deja_search..." footer teaches the agent about in-session memory access on every session start.
- No markdown headers inside the `<system-reminder>` — just `##` for visual scanning by the LLM. The block is not rendered to the user.

### Token Budget Enforcement

Token count is estimated using a **character-based heuristic: 4 characters ≈ 1 token**. This avoids requiring a tokenizer library dependency.

The context generator fills the budget in priority order:
1. **Last session summary** — allocated up to 40% of budget (3200 chars)
2. **High-significance observations** — allocated up to 50% of budget (4000 chars). Observations are added in significance × recency order until budget is exhausted. If a single observation exceeds remaining budget, it is truncated at the last complete sentence.
3. **Cross-project insights** — allocated remaining 10% (800 chars)

If a section underflows (e.g., no session summary exists), its budget rolls to the next section. Configurable via `context_budget` setting (in characters, not tokens, to keep it deterministic).

### Cross-Project Insights (Detailed)

Cross-project context injection is opt-in and conservative. It works by matching concepts extracted from the current project against concepts from other projects:

- Concepts are **normalized before storage**: lowercased, hyphens/underscores/spaces collapsed to hyphens (e.g., `"rate_limiting"`, `"Rate Limiting"`, `"ratelimiting"` all become `"rate-limiting"`). Matching uses the normalized form from the `concepts` JSON array
- A match requires **at least 2 shared concepts** to avoid false positives (e.g., "configuration" alone is too generic)
- Only `high` and `critical` significance observations from other projects are surfaced
- Maximum: 2 cross-project observations per session injection
- Disabled by default in settings — users enable via `npx deja settings --cross-project true`

**Matching algorithm (runs in SessionStart, must complete within 200ms budget):**

The current project's concept vocabulary is collected first: all unique concepts from observations with `significance IN ('high', 'critical')` for the current project, limited to the most recent 50 observations (to bound scan size). This produces a small set (typically 20–80 unique concepts after dedup).

```sql
-- Step 1: Collect current project's concept vocabulary
-- (Application code: parse JSON arrays, dedup into a Set<string>)
SELECT concepts FROM observations
WHERE project = :current_project AND significance IN ('high', 'critical')
ORDER BY created_at_epoch DESC LIMIT 50;

-- Step 2: Find candidate observations from other projects
-- (Application code: for each candidate, parse its concepts JSON array
--  and count intersection with the current project's concept set.
--  Keep candidates with ≥ 2 shared concepts.)
SELECT id, concepts, title, content, significance, created_at_epoch
FROM observations
WHERE project != :current_project AND significance IN ('high', 'critical')
ORDER BY created_at_epoch DESC LIMIT 200;
```

The application code iterates the Step 2 results, parses each `concepts` JSON array, counts the intersection with the Step 1 set, and keeps observations with ≥ 2 shared concepts. Results are ranked by `shared_concept_count DESC, created_at_epoch DESC` and the top 2 are selected. The 200-row limit on Step 2 bounds the scan to well under 200ms even on large databases. If performance becomes an issue (measured, not speculated), a future optimization could maintain a `concept_index` table — but the current approach is simple and fast enough for the expected data volumes.

Example of a useful cross-project insight: you're working on `ibkr-mcp-server` and touch rate-limiting code. deja surfaces a `critical` observation from your `trading-bot` project: "Discovered IBKR API rate limit is 50 req/s, not 100 as documented." That's genuinely helpful. But surfacing "edited README" from an unrelated project because both have `["documentation"]` as a concept — that's noise. The 2-concept minimum + high significance filter prevents this.

## Error Handling & Resilience

**Core principle: deja must never interfere with Claude Code.** If deja crashes, Claude Code works exactly as if deja isn't installed.

| Failure | Recovery |
|---|---|
| Worker crashed | Hook writes to pending.wal. Next hook auto-restarts worker, drains WAL. |
| Socket refused | Same — WAL + auto-restart. |
| SQLite locked | Retry 3× with 50ms backoff. If still locked, write to WAL. |
| SQLite corrupted | Detected by `SQLITE_CORRUPT` (error code 11) or `SQLITE_NOTADB` (error code 26) during open or any query. On detection: log the full error, move `memory.db` to `memory.db.bak` (overwriting any existing backup), create a fresh DB with the latest schema. Other SQLite errors (BUSY, LOCKED, IOERR) do NOT trigger recreation — they have their own retry/fallback paths. |
| sqlite-vec fails to load | Graceful degradation — FTS5 only. Log warning. |
| tree-sitter parse fails | Fall back to heuristic extractor (regex-based). |
| LLM API fails | Fall back to AST/heuristic extractor. Never blocks pipeline. |
| Hook timeout | Most hooks return within 2s. Stop hook has a 10s timeout (waits for session summary). Heavy work is async in the worker. |
| Embedding generation fails | Store observation without embedding. FTS still works. Retry in background. |

### WAL (Write-Ahead Log) — `~/.deja/pending.wal`

Newline-delimited JSON. Safety net for worker unavailability.

```
Hook fires → Worker unavailable → Append to pending.wal
Worker restarts → Read WAL → Process events → Truncate WAL
```

Max WAL size: 10MB. When the WAL approaches 8MB, a warning is logged. At 10MB, the oldest events are dropped to make room — this indicates the worker has been down for an abnormally long time (~10,000 unprocessed events).

**WAL concurrency:** Multiple hooks can fire in parallel (e.g., PostToolUse for two simultaneous Claude sessions). The WAL file uses a **lockfile protocol** (`~/.deja/pending.wal.lock`) for safe concurrent writes:

1. Hook acquires an exclusive lock on the lockfile via `flock(fd, LOCK_EX)` (blocks until acquired)
2. Appends JSON + newline to `pending.wal`
3. Releases the lock

This is necessary because hook payloads can exceed `PIPE_BUF` (4096 bytes on Linux), making `O_APPEND` atomicity unreliable for large events. The lockfile approach is correct at all payload sizes. Lock acquisition is <1ms under contention — negligible for a failover path.

On crash recovery, the WAL reader skips any incomplete JSON line at the end of the file (detected by JSON parse failure on the last line). A partial write can only occur if the process was killed mid-`write()` call — the lock prevents interleaving, but not mid-syscall crashes.

## Event Debouncing

During rapid-fire tool use (e.g., Claude edits 10 files in quick succession), the worker batches events within a **100ms fixed debounce window, per session**. When the first event arrives for a session, a 100ms timer starts. All events for that session received before the timer fires are processed as a batch. The window is fixed, not sliding — a new event does not extend the timer. Events from different sessions are debounced independently.

- Multiple file edits in the same window → single "multi-file edit" observation with higher significance
- Repeated bash commands (e.g., test reruns) → deduplicated, only final result stored
- Sequential reads of files in the same directory → grouped into a single "explored directory" observation

This reduces observation noise and naturally produces higher-quality observations for rapid-fire patterns.

**Debounce output shape:** The debouncer emits each event to the classifier with a `_batch` annotation object added to the raw payload:

```typescript
interface BatchAnnotation {
  batch_size: number;          // total events in this debounce window for this session
  batch_index: number;         // 0-based position of this event in the batch
  multi_file_edit: boolean;    // true if batch contains ≥ 2 Edit/Write events for different files
  unique_files: string[];      // deduplicated file paths across all Edit/Write events in the batch
}
```

The classifier reads `_batch.multi_file_edit` for the HIGH significance rule. The normalize stage strips `_batch` before writing `raw_event` — it's an internal annotation, not part of the stored event.

## Schema Migrations

Migrations are sequential, numbered scripts in `src/kernel/migrations/`:

```
migrations/
├── 001_initial.ts
├── 002_add_concepts_index.ts
└── ...
```

On worker startup:
1. Read `schema_version` table for current version
2. Run all migrations with version > current, in order
3. Each migration runs in a transaction — if it fails, it rolls back and the worker logs an error
4. The worker refuses to start if a migration fails (data integrity > availability)

Migrations are forward-only. No rollback scripts — if a migration needs to be reversed, a new forward migration is created.

## Privacy & Data Handling

**All data stays local.** The `~/.deja/memory.db` file never leaves the machine. No telemetry, no analytics, no phone-home.

**When LLM extraction is enabled (Tier 3, opt-in only):**
- The observation's normalized content (file diffs, bash output summaries) is sent to the configured LLM provider
- Raw file contents are NOT sent — only the truncated content_summary (max 2000 chars) from the normalize stage
- The user explicitly enables this and provides their own API key
- All LLM calls go directly to the provider — deja has no intermediary server

**What is captured:**
- File paths read and modified
- Truncated file diffs and bash outputs
- Tool names and actions
- Session metadata (start time, end time, project path)

**What is NOT captured:**
- File contents in full (truncated to 2000 chars in normalize stage)
- Credentials, API keys, or secrets (the classifier skips `.env`, `credentials.*`, `*.pem` files)
- Anything from `excluded_projects` paths

## CLI & Configuration

### Install Flow (`npx deja install`)

The install command is the first-touch experience. It must work perfectly with zero user decisions.

```
npx deja install
  1. Pre-flight checks:
     → Verify Bun is installed and >= 1.3.6 (error with install instructions if not)
     → Verify Claude Code is installed (check for ~/.claude/ directory)
     → If deja is already installed, print "deja is already installed. Run npx deja update to upgrade." and exit 0
  2. Create data directory:
     → mkdir -p ~/.deja/logs/
     → Write ~/.deja/settings.json with default values (all tiers off, 8000 char budget)
  3. Register with Claude Code:
     → Copy plugin.json, hooks.json, .mcp.json into Claude Code's plugin directory
       (~/.claude/plugins/deja/ — Claude Code discovers plugins from this directory)
     → The dist/ directory is referenced from the npm package location
       (hooks.json commands use absolute paths resolved at install time)
  4. Initialize database:
     → Create ~/.deja/memory.db with schema from 001_initial.ts migration
     → Set schema_version to 1
  5. Print success:
     → "deja installed. Memory starts building on your next Claude Code session."
     → "Run 'npx deja status' to verify."
```

**Idempotent:** Running `install` when already installed is safe — it prints a message and exits. A separate `npx deja update` command handles version upgrades.

### Update Flow (`npx deja update`)

```
npx deja update
  1. Pre-flight checks:
     → Verify deja is installed (check ~/.claude/plugins/deja/ exists)
     → If not installed: "deja is not installed. Run 'npx deja install' first." and exit 1
  2. Stop the worker if running (send SIGTERM, wait 5s)
  3. Update the package:
     → The npm package is already updated by the time `npx deja update` runs
       (npx fetches the latest version automatically)
  4. Re-resolve hook paths:
     → Rewrite hooks.json commands with absolute paths to the new dist/ location
       (npm package may have moved on update)
     → Copy updated hooks.json to ~/.claude/plugins/deja/
  5. Run schema migrations:
     → Open memory.db, read schema_version, run any new migrations
     → Print: "Migrated schema from v2 to v4 (2 migrations applied)"
     → Or: "Schema already up to date (v4)"
  6. Handle settings.json schema changes:
     → Read existing settings.json, merge with new default fields
     → New fields get default values. Existing fields are preserved.
     → Removed fields (if any) are left in the file but ignored.
  7. Print success:
     → "deja updated to v0.3.0. Worker will restart on next hook fire."
     → "Run 'npx deja status' to verify."
```

**The worker is NOT auto-restarted.** It starts lazily on the next hook fire. This avoids needing to keep the worker alive during the update process.

### Uninstall Flow (`npx deja uninstall`)

```
npx deja uninstall
  1. Stop the worker if running (send SIGTERM, wait 5s)
  2. Ask: "Delete memory database? (y/N)"
     → Yes: remove ~/.deja/ entirely
     → No: remove only plugin registration (~/.claude/plugins/deja/), leave ~/.deja/ intact
       → Print: "Hooks removed. Memory preserved at ~/.deja/memory.db"
  3. Print: "deja uninstalled."
```

**The DB question is separate from the hook removal.** Users who are temporarily disabling deja should keep their memory. Users who are done forever should clean up.

### Commands

```bash
# Installation
npx deja install           # Register hooks + MCP server
npx deja uninstall         # Clean removal (with confirmation)

# Status
npx deja status            # Quick health check
npx deja status --verbose  # Full diagnostic

# Settings
npx deja settings                        # Show current
npx deja settings --llm claude           # Enable LLM extraction
npx deja settings --llm off              # Back to local-only
npx deja settings --context-budget 12000 # Characters (~3000 tokens) at session start
npx deja settings --retention 90d        # Optional: prune low/medium observations older than 90d
npx deja settings --retention off        # Default: keep everything
npx deja settings --cross-project true   # Enable cross-project context injection
npx deja settings --cross-project false  # Default: disabled

# Search (terminal use — reads memory.db directly in SQLITE_OPEN_READONLY mode,
# same FTS5 pipeline as MCP deja_search. Works even when the worker is stopped.)
npx deja search "order confirmation"
npx deja search --project ./my-app
npx deja search "rate limiting" --kind file_edit --significance high
# Output: lightweight format (same fields as MCP deja_search):
#   #247  CRITICAL  file_edit   May 22, 10:15 PM  Wrote design spec for deja plugin
#   #233  HIGH      bash_cmd    May 22, 9:01 PM   Tests: 42 passed, 3 failed
# Pagination: --limit 20 (default) --offset 0. Shows "N more results" if truncated.

# List sessions (needed for replay/diff session IDs)
npx deja sessions                     # Last 20 sessions for current project
npx deja sessions --all               # All projects
npx deja sessions --limit 50          # More results
# Output:
#   ID                    Project                Date                  Observations
#   abc123-def456         ibkr-mcp-server        May 22, 10:15 PM      24
#   xyz789-ghi012         ibkr-mcp-server        May 22, 8:30 PM       12

# Dashboard
npx deja dashboard              # Opens browser to localhost:3333 (or next available port)
npx deja dashboard --port 8080  # Custom port

# Learn codebase (CLI, not through agent)
npx deja learn                    # Read all source files, build memory
npx deja learn --dry-run          # Preview what would be read

# Maintenance
npx deja compact           # VACUUM SQLite, reclaim space
npx deja export            # Export all observations as JSON
npx deja import file.json  # Import from export
```

### Status Output (`npx deja status`)

```
deja status — ibkr-mcp-server (/Users/alice/projects/ibkr-mcp-server)

Worker:       running (PID 12847, uptime 2h 14m)
Database:     4.2 MB (1,247 observations, 47 sessions)
Tiers:        FTS5 ✓  AST ✗  Vectors ✗  LLM ✗
```

**`--verbose` adds:**

```
deja status --verbose — ibkr-mcp-server

Worker:       running (PID 12847, uptime 2h 14m)
Database:     4.2 MB (1,247 observations, 47 sessions)
Tiers:        FTS5 ✓  AST ✗  Vectors ✗  LLM ✗

WAL:          0 bytes (healthy)
Queue depth:  0
Socket:       /Users/alice/.deja/worker.sock (connected)
Log level:    warn
Log file:     ~/.deja/logs/deja-2026-05-22.log (12 KB)

LLM:          disabled
Cross-project: disabled
Retention:    off (keep everything)
Context budget: 8,000 chars
```

**When worker is stopped:**

```
Worker:       stopped (no worker.pid)
Database:     4.2 MB (1,247 observations, 47 sessions)
Tiers:        FTS5 ✓  AST ✗  Vectors ✗  LLM ✗
```

The project is determined by `cwd`. If `cwd` doesn't match any project in the DB, status still shows worker health and global DB size, but omits the project name and shows "No observations for this project."

### Compact Flow (`npx deja compact`)

```
npx deja compact
  1. Check if worker is running (read worker.pid, verify via kill(pid, 0))
     → If running: send SIGTERM, wait up to 5s for clean shutdown
     → If not running: continue
  2. Check if MCP server has the DB open:
     → Not feasible to detect reliably. Instead, use PRAGMA wal_checkpoint(TRUNCATE)
       before VACUUM to flush WAL. VACUUM will fail if another process holds a lock —
       catch the SQLITE_BUSY error and retry up to 3 times with 1s backoff.
     → If still BUSY after 3 retries: "Database is locked by another process. Close any
       open deja dashboard or Claude Code sessions and try again."
  3. Record size before: stat ~/.deja/memory.db
  4. Run VACUUM
  5. Record size after
  6. Print: "Compacted memory.db: 4.8 MB → 4.2 MB (saved 600 KB)"
     → Or: "Compacted memory.db: 4.2 MB → 4.2 MB (no space to reclaim)"
  7. Worker is NOT restarted — it starts lazily on the next hook fire.
```

### Import Flow (`npx deja import file.json`)

```
npx deja import file.json
npx deja import file.json --dry-run    # Preview without importing
```

**How it works:**

1. **Parse and validate:** Read the JSON file. Check `version` field matches a known format (currently only version 1). If unknown version: "Unsupported export format version {N}. Update deja and try again." Exit 1.
2. **Create missing sessions:** For each session in the export, INSERT OR IGNORE into the sessions table. Existing sessions (same ID) are left unchanged.
3. **Import observations with new IDs:** Observations are inserted with `id` omitted — SQLite assigns new AUTOINCREMENT IDs. Original IDs from the export are NOT preserved (they may conflict with existing data). The observation's `session_id`, `project`, and all other fields are imported as-is.
4. **Skip duplicates:** Before each INSERT, check if an observation with the same `project` + `created_at_epoch` + `title` already exists. If so, skip it. (Same dedup logic as claude-mem import.)
5. **FTS sync:** All inserts go through the observations table — triggers handle FTS automatically.
6. **Embeddings:** The `embedding` column is set to NULL for all imported observations. If Tier 2 is enabled, a post-import prompt offers to backfill: "Generate embeddings for 340 imported observations? (y/N)"
7. **Report:**
   ```
   Imported from file.json:
     Sessions:     12 created, 3 skipped (already exist)
     Observations: 340 imported, 15 skipped (duplicates)
     Embeddings:   not generated (Tier 2 disabled)
   ```

**`--dry-run` output:**
```
Dry run — no changes made:
  Would create: 12 sessions, 340 observations
  Would skip:   3 sessions (exist), 15 observations (duplicates)
```

### Configuration (`~/.deja/settings.json`)

```json
{
  "context_budget": 8000,
  "tiers": {
    "ast": false,
    "vectors": false
  },
  "llm": {
    "enabled": false,
    "provider": null,
    "model": null,
    "base_url": null
  },
  "retention": null,
  "cross_project": false,
  "log_level": "warn",
  "log_max_days": 30,
  "excluded_projects": [],
  "debounce_ms": 100,
  "worker_idle_timeout_minutes": 30,
  "tcp_port": 19532
}
```

Zero required configuration. Everything works out of the box.

**API keys are NEVER stored in settings.json.** They are read from environment variables at runtime:
- `ANTHROPIC_API_KEY` for claude provider
- `GEMINI_API_KEY` for gemini provider
- `DEJA_LLM_API_KEY` for custom provider (or `OPENAI_API_KEY` as fallback)

This prevents accidental exposure via backups, file sharing, or process inspection. The `settings.json` file stores only the provider name, model, and base_url — never secrets.

### Export Flow (`npx deja export`)

```bash
npx deja export                          # Export current project → deja-export-YYYY-MM-DD.json
npx deja export --all                    # Export all projects
npx deja export --project /path/to/app   # Export a specific project
npx deja export --output backup.json     # Custom output path
npx deja export --since 30d             # Only observations from the last 30 days
npx deja export --dry-run               # Show counts without writing
```

**How it works:**

1. **Scope:** By default, exports observations and sessions for the current project (`cwd`). `--all` exports everything. `--project` exports a specific project path.
2. **Output path:** Default is `deja-export-YYYY-MM-DD.json` in the current directory. Override with `--output`.
3. **Query:** `SELECT * FROM observations WHERE project = ? ORDER BY created_at_epoch ASC`. Sessions are included for any session_id referenced by the exported observations.
4. **Write:** Serialize to JSON, write atomically (write to `.tmp`, rename).
5. **Report:**
   ```
   Exported to deja-export-2026-05-23.json:
     Sessions:     47
     Observations: 1,247
     File size:    2.8 MB
   ```

### Export Format

`npx deja export` produces a JSON file with this structure:

```json
{
  "version": 1,
  "exported_at": 1716400000000,
  "sessions": [
    { "id": "...", "project": "...", "started_at_epoch": 0, "ended_at_epoch": 0, "summary": "..." }
  ],
  "observations": [
    { "id": 1, "session_id": "...", "project": "...", "significance": "medium", "kind": "file_edit", "title": "...", "content": "...", "facts": [], "concepts": [], "files_read": [], "files_modified": [], "created_at_epoch": 0 }
  ]
}
```

The `version` field enables forward-compatible imports. `embedding` is excluded from exports (regenerated on import). `raw_event` IS included — it enables reprocessing after import and maintains export/import losslessness. The export file may be large; users can compress it.

### File Layout

```
~/.deja/
├── memory.db          # Single SQLite file (everything)
├── worker.sock        # Unix domain socket (macOS/Linux)
├── worker.pid         # Worker process ID
├── worker.lock        # flock lockfile — ensures single worker instance
├── pending.wal        # Write-ahead log (empty when healthy)
├── pending.wal.lock   # flock lockfile — serializes WAL append/drain access
├── settings.json      # User configuration
└── logs/
    └── deja-YYYY-MM-DD.log  # Auto-rotated: files older than log_max_days deleted
```

No files inside project directories. Projects identified by path in the database.

**Log format:** Plain text, one line per entry. Format: `YYYY-MM-DDTHH:MM:SS.sss LEVEL [component] message`

```
2026-05-22T22:15:03.442 INFO  [socket]    Worker started, listening on /Users/alice/.deja/worker.sock
2026-05-22T22:15:03.512 INFO  [wal]       Drained 3 pending events from WAL
2026-05-22T22:15:04.001 DEBUG [classify]  PostToolUse:Edit → significance=high (multi-file edit)
2026-05-22T22:15:04.015 DEBUG [extract]   Heuristic: "Modified ConnectionManager.reconnect()"
2026-05-22T22:15:04.018 DEBUG [db]        INSERT observation #248 (high, file_edit)
2026-05-22T22:16:30.000 WARN  [queue]     Event queue depth exceeds 5000
2026-05-22T23:45:00.000 INFO  [worker]    Idle timeout (30m). Shutting down.
```

**What is logged at each level:**

| Level | What |
|---|---|
| `error` | SQLite corruption, migration failure, unrecoverable crashes |
| `warn` | LLM API failure + fallback, sqlite-vec load failure, WAL approaching limit, queue depth warning |
| `info` | Worker start/stop, WAL drain, session start/end, tier enable/disable, migration applied |
| `debug` | Every event classification, extraction result, FTS insert, embedding generation, socket message received |

Default level is `warn` — users see only problems. `npx deja settings --log-level debug` enables full tracing. **Changing log level requires worker restart** (kill the worker, it restarts on next hook fire). This is acceptable because log level changes are rare and the restart is invisible.

**Log rotation:** On worker startup, log files older than `log_max_days` (default: 30) are deleted. No background rotation — cleanup happens at startup only.

## Testing Strategy

```
Unit tests (pure functions, zero mocking):
  pipelines/ingest/classify.test.ts
  pipelines/ingest/normalize.test.ts
  pipelines/extract/ast.test.ts
  pipelines/extract/heuristic.test.ts
  pipelines/search/fts.test.ts
  pipelines/search/rerank.test.ts
  context/generator.test.ts

Integration tests (pipeline end-to-end):
  ingest.integration.ts    → raw hook event → stored observation
  search.integration.ts    → store 100 obs → query → relevant results
  context.integration.ts   → populate DB → session start → correct injection

Smoke tests (actual Claude Code hooks):
  plugin.smoke.ts          → install, fire hooks, verify DB populated
```

Coverage target: 90%+ on pipeline stages, 70%+ on kernel/IPC.

## Web Dashboard

A single-page web UI served by `Bun.serve()` — no React, no build step, no external dependencies. One HTML file with embedded CSS/JS.

### Launch

```bash
npx deja dashboard          # Opens browser to http://localhost:3333
npx deja dashboard --port 8080  # Custom port
```

The dashboard reads directly from `memory.db` (read-only) via a lightweight REST API served by the same Bun process.

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│  deja                          [Project: ibkr-mcp-server ▼]  │
├──────────────────────────────────────────────────────────────┤
│  Status Bar                                                   │
│  1,247 observations │ 12 sessions │ 4.2MB │ Worker: healthy  │
│  Tiers: FTS5 ✓  AST ✓  Vectors ✗  LLM ✗                    │
├──────────────────────────────────────────────────────────────┤
│  🔍 Search observations...                    [Filters ▼]    │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  SESSION: May 22, 10:15 PM — 11:42 PM                       │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Summary: Designed deja persistent memory plugin.        │ │
│  │ Decided on micro-kernel + pipeline architecture,        │ │
│  │ single SQLite file, heuristic-first extraction.         │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ● CRITICAL  Wrote design spec (2026-05-22-deja-design.md)   │
│  ● HIGH      Added SQLite schema with FTS5 triggers          │
│  ○ MEDIUM    Read claude-mem hooks.json                       │
│  ○ MEDIUM    Compared sqlite-vec vs LanceDB                  │
│  ○ LOW       Ran sqlite3 status query                        │
│  ┈ 12 more observations...                          [expand] │
│                                                               │
│  SESSION: May 22, 8:30 PM — 9:15 PM                         │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Summary: Analyzed claude-mem plugin architecture.       │ │
│  │ Found gaps: fragile IPC, ChromaDB dependency, no GC.    │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ● HIGH      Explored claude-mem worker-service.cjs          │
│  ○ MEDIUM    Checked database schema and tables              │
│  ┈ 8 more observations...                           [expand] │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### Components

| Component | What it shows |
|---|---|
| **Project Switcher** | Dropdown of all projects with observation counts. Switches the entire view. |
| **Status Bar** | Live stats: observation count, session count, DB size, worker health, active tiers. |
| **Search** | Full-text search across observations. Uses the same FTS5 + sqlite-vec pipeline as the MCP tools. Filters by significance, kind, date range. |
| **Session Timeline** | Chronological list of sessions, newest first. Each session shows its summary (collapsible) and observations grouped by significance. |
| **Observation Detail** | Click any observation to expand: full content, facts, concepts, files touched, raw event (collapsible). |

### Technical Implementation

- **Server:** `Bun.serve()` bound to `127.0.0.1` (never `0.0.0.0`) — ~30 lines of routing code
- **Authentication:** On startup, the dashboard generates a random 32-byte hex token and passes it to the browser as a URL fragment (`http://localhost:3333/#token=<hex>`). All API requests must include `Authorization: Bearer <token>`. Requests without a valid token receive `401 Unauthorized`. The token is ephemeral — regenerated on each dashboard launch.
- **CORS:** All API responses include `Access-Control-Allow-Origin: null` (reject all cross-origin requests). This prevents malicious web pages from querying the user's memory via JavaScript.
- **REST API endpoints:**
  - `GET /api/projects` — list all projects with stats
  - `GET /api/sessions?project=<path>&limit=20&offset=0` — paginated sessions
  - `GET /api/observations?session=<id>` — observations for a session
  - `GET /api/search?q=<query>&project=<path>` — search observations
  - `GET /api/status` — worker health, tier status, DB size. Worker liveness is determined by reading `worker.pid`, calling `process.kill(pid, 0)` (signal 0 — checks if process exists without killing it), and checking the PID file's mtime (stale if > 2× `worker_idle_timeout_minutes`). Returns `{ worker: "running" | "stopped" | "stale", pid: number | null, uptime_seconds: number | null }` along with tier status and DB file size via `Bun.file(dbPath).size`.
- **Frontend:** Single HTML file with vanilla JS (no framework). CSS uses system fonts and `prefers-color-scheme` for automatic dark mode. Served from `src/dashboard/index.html`, inlined at build time. The JS reads the token from the URL fragment and includes it in all fetch requests.
- **No WebSocket:** The dashboard is not real-time. Users refresh or re-search to see new data. This keeps the implementation simple and avoids long-lived connections.

**API Response Format (all endpoints):**

Success: `200 OK` with JSON body matching the endpoint's schema.

Error: JSON body with consistent shape:
```json
{ "error": "Session not found", "code": "NOT_FOUND", "status": 404 }
```
Error codes: `NOT_FOUND` (404), `BAD_REQUEST` (400, e.g., missing required query param), `UNAUTHORIZED` (401, invalid/missing bearer token), `INTERNAL` (500).

**Pagination (sessions, observations, search):**

All list endpoints support `limit` (default 20, max 100) and `offset` (default 0). Response includes:
```json
{ "data": [...], "total": 247, "limit": 20, "offset": 0, "has_more": true }
```
The frontend uses `has_more` to show/hide "Load more" buttons. `/api/observations?session=<id>` also supports pagination — sessions can have hundreds of observations.

### Why Not Real-Time Logs?

claude-mem's dashboard is primarily a log viewer (Hook, Worker, SDK, Parser, DB, System, HTTP, Session, Chroma filters). That's useful for debugging the plugin itself, but it's developer tooling, not user-facing value.

deja's dashboard shows **your memory** — what the AI knows about your work. Logs go to `~/.deja/logs/` for debugging; the dashboard surfaces insights, not implementation details.

A real-time log viewer can be added in a future version if debugging demand warrants it. For v1, `tail -f ~/.deja/logs/deja-$(date +%Y-%m-%d).log` is sufficient.

## LLM Provider Support (Tier 3)

When LLM extraction is enabled, deja uses a simplified two-path provider model:

### Direct Providers

For users with a single provider API key. Zero configuration beyond the key itself.

```bash
npx deja settings --llm claude    # Anthropic — Haiku for simple events, Sonnet for summaries
npx deja settings --llm gemini    # Google — Gemini Flash (free tier available)
```

### Custom Provider (OpenAI-compatible)

For any endpoint that speaks the OpenAI API format — covers LiteLLM, OpenRouter, Ollama, vLLM, local models, and any future proxy.

```bash
# Set API key via environment variable (never stored on disk)
export DEJA_LLM_API_KEY=lm_abc123

npx deja settings --llm custom \
  --base-url http://localhost:4000/v1 \
  --model claude-haiku-4-5-20251001
```

This single path replaces the need for named providers for every new service. Examples:

| Service | base-url | Notes |
|---|---|---|
| LiteLLM | `http://localhost:4000/v1` | Local proxy, 100+ providers |
| OpenRouter | `https://openrouter.ai/api/v1` | Multi-provider API |
| Ollama | `http://localhost:11434/v1` | Local models, no API key needed |
| vLLM | `http://localhost:8000/v1` | Self-hosted inference |
| Any OpenAI-compatible | `https://your-endpoint/v1` | Works with any compliant API |

### Settings result

```json
{
  "llm": {
    "enabled": true,
    "provider": "custom",
    "base_url": "http://localhost:4000/v1",
    "model": "claude-haiku-4-5-20251001"
  }
}
```

API key is read from `DEJA_LLM_API_KEY` environment variable at runtime (see Configuration section).

### LLM Extraction Prompt (Tier 3)

When an observation is routed to the LLM extractor (high/critical events with Tier 3 enabled), deja sends this prompt:

```
System: You are a code observation extractor. Given a developer tool event, produce a structured observation. Respond with ONLY valid JSON matching the schema below. No markdown, no explanation.

Schema:
{
  "title": "one-line summary, max 100 chars (e.g., 'Modified ConnectionManager.reconnect() to add exponential backoff')",
  "content": "2-4 sentence narrative: what happened, why it matters, what changed (max 500 chars)",
  "facts": ["atomic fact 1", "atomic fact 2", ...],  // max 5 facts, each < 100 chars
  "concepts": ["concept-1", "concept-2", ...]  // max 5 normalized kebab-case concepts
}

User: <normalized event content, max 2000 chars from normalize stage>
```

**Response parsing:**
1. Parse as JSON. If parse fails → retry once with "Respond with valid JSON only."
2. If retry fails → fall back to heuristic extractor for this event.
3. Validate field lengths. Truncate `title` at 100 chars, `content` at 500 chars, cap arrays at 5 items.
4. Normalize concepts (lowercase, collapse separators to hyphens).

**Model routing:** Only `high` and `critical` events reach the LLM extractor (see Extract stage). Within those: `high` → cheapest model (Haiku/Flash). `critical` → capable model (Sonnet/Flash). The classifier's significance drives this directly — no additional routing logic needed.

**Token budget:** Extraction requests: max 300 output tokens. Summary requests: max 500 output tokens.

### Session Summary Prompt (Tier 3)

```
System: Summarize this coding session in 2-3 sentences. Focus on: what was accomplished, key decisions made, and what was learned. Max 300 characters. Plain text, no markdown.

User: Session observations (titles only):
- Modified ConnectionManager.reconnect() to add exponential backoff
- Tests: 42 passed, 3 failed (test_orders.py)
- Created design spec for deja plugin
- ...
```

The summary prompt receives only observation titles (not full content) to stay within token limits for sessions with many observations. Max 50 titles included, sorted by significance.

### Validation

On first LLM-enabled observation, deja sends a test request. If it fails, it logs the error, disables LLM extraction, and falls back to heuristic/AST — the user is notified in the next SessionStart context injection.

## Migration from claude-mem

For users switching from claude-mem, deja provides a one-command migration that imports all existing observations without data loss.

### Import Command

```bash
npx deja import-from-claude-mem              # Auto-detects ~/.claude-mem
npx deja import-from-claude-mem --path /custom/path  # Custom location
npx deja import-from-claude-mem --dry-run    # Preview: counts what would be imported
```

### How It Works

1. **Locate claude-mem data:** Reads from `~/.claude-mem/sqlite/memories.db` (SQLite) and optionally the ChromaDB directory for embeddings.
2. **Map schema:** claude-mem's `memories` table fields are mapped to deja's `observations` schema:
   - `narrative` → `content`
   - `title` → `title`
   - `kind` → `kind` (mapped to deja's vocabulary: `file_read`, `file_edit`, `bash_cmd`, `decision`)
   - `projectId` → `project`
   - `metadata.files` → `files_read` / `files_modified`
   - `created_at` → `created_at_epoch` (converted to epoch ms)
   - `session_id` → creates sessions entries grouped by claude-mem's session boundaries
3. **Re-classify:** Each imported observation is run through deja's `classify` stage to assign a `significance` value — claude-mem has no equivalent, so all observations get properly triaged.
4. **Skip duplicates:** If deja already has observations for the same project + timestamp + title, they are skipped. Safe to run multiple times.
5. **FTS integrity:** All inserts go through standard `INSERT INTO observations` — never directly into the FTS table. The triggers handle FTS sync automatically. This constraint applies to ALL write paths (import, migration, re-extraction).
6. **Report:** Prints summary: observations imported, sessions created, observations skipped (duplicates), observations dropped (unparseable).

### What Doesn't Transfer

- **ChromaDB embeddings** — Regenerated by deja's Tier 2 pipeline if vectors are enabled. Old embeddings are model-incompatible.
- **claude-mem corpora** — These are claude-mem's abstraction layer. Deja's FTS5 index replaces their function.
- **Raw events** — claude-mem doesn't store raw hook payloads. Imported observations have `raw_event` set to `"imported:claude-mem"` (a marker, not reprocessable).

## User Data Control

"Your agent never forgets" — but the user always has the power to make it forget.

### Forget Commands

```bash
# Forget a specific session and all its observations
npx deja forget --session <session-id>

# Forget all observations matching a query (current project only; add --all-projects for global)
npx deja forget --search "secret project"

# Forget everything from a specific project
npx deja forget --project /path/to/project

# Forget observations older than a date
npx deja forget --before 2026-01-01

# Forget everything (nuclear option — with double confirmation)
npx deja forget --everything

# Preview what would be deleted without deleting
npx deja forget --session <id> --dry-run
```

### Behavior

- **Permanent deletion:** `forget` performs a hard `DELETE` from SQLite. No soft-delete, no trash, no recovery. When a user says forget, they mean forget. Space is not reclaimed immediately — run `npx deja compact` afterward to reclaim disk space. (VACUUM requires exclusive DB access; `forget` may run while the worker is active, so it only does the DELETE.)
- **FTS5 cleanup:** The DELETE trigger on `observations` fires, removing entries from `observations_fts`. No phantom search results.
- **Embedding cleanup:** If sqlite-vec is active, the corresponding embedding rows are deleted.
- **Session cleanup:** If all observations in a session are deleted, the session row is also deleted. If some remain, the session stays but its summary is **regenerated using the Tier 0 heuristic** (top 5 remaining observation titles by significance, same logic as the Stop hook's non-LLM path) — regardless of what tier originally created the summary. This keeps `forget` deterministic and avoids requiring an LLM call.
- **Confirmation:** All `forget` commands (except `--dry-run`) require interactive confirmation showing the count of observations to be deleted. `--everything` requires typing "forget everything" to confirm.
- **Audit trail:** A one-line log entry records what was forgotten (count and scope), but not the content itself.

### Exclude Projects

To prevent deja from ever observing a project:

```bash
npx deja settings --exclude /path/to/sensitive-project
```

This adds the path to `excluded_projects` in settings.json. The classify stage checks this list first — events from excluded projects are dropped before any processing. **Path matching is directory-prefix-based:** the excluded path must match either exactly or followed by a `/` separator. Excluding `/Users/alice/projects` also excludes `/Users/alice/projects/subproject` but does NOT exclude `/Users/alice/projects-other` (no false positives from naive string prefix matching). Implementation: `cwd === excluded || cwd.startsWith(excluded + '/')`. Existing observations from an excluded project are NOT retroactively deleted (use `forget --project` for that).

## Skills

deja registers two skills that Claude Code agents can invoke for in-session memory operations.

### `deja-search` Skill

A guided search workflow that teaches agents the 3-layer search protocol — preventing context window blowout from naive "fetch everything" patterns.

```
Skill: deja-search
Description: Search your memory — past sessions, decisions, code changes, and debugging history.

Instructions to agent:
  Use the 3-layer MCP protocol to search efficiently:
  1. deja_search(query) → lightweight index (id, title, significance, date)
  2. deja_timeline(anchor=ID) → chronological context around a result
  3. deja_observe(ids=[...]) → full details, MAX 10 IDs per request

  NEVER call deja_observe without filtering through deja_search first.
  10× token savings vs fetching everything.
```

### `deja-learn` — CLI Command (not a skill)

Front-loads memory for a new codebase. This is a **CLI command** (`npx deja learn`), not a skill — because reading 500 files through Claude Code's Read tool would overwhelm the agent's context window. Instead, deja reads files directly and generates observations through its own pipeline.

```bash
npx deja learn                    # Learn current directory
npx deja learn /path/to/project   # Learn a specific project
npx deja learn --dry-run          # Show what would be read, without processing
npx deja learn --max-files 200    # Override default cap
```

**How it works:**

```
npx deja learn
  1. Ensure the worker is running:
     → Same startup check as hooks: read worker.pid, verify alive, try socket connect
     → If not running: acquire lockfile, spawn worker (detached), wait for socket ready
       (max 10 attempts, 200ms apart, 2s total — identical to hook startup logic)
     → If worker cannot be started: "Worker failed to start. Check 'npx deja status --verbose'." Exit 1.
     → The learn command CANNOT process events without the worker — unlike hooks, which
       can fall back to WAL, learn needs observations to exist in the DB for its final
       summary query (step 9). WAL-only operation would produce 0 observations.
  2. Create a synthetic session:
     → Generate session ID: "learn-{timestamp}" (e.g., "learn-1716400000000")
     → INSERT INTO sessions (id, project, started_at_epoch) VALUES (learn_id, cwd, now())
     → This session is indistinguishable from a real session in search/timeline/replay
       except for its "learn-" prefix, which the dashboard can display as a badge
  3. Walk the project tree (respecting .gitignore)
  4. Filter: skip files > 100KB, skip binary files, skip node_modules/vendor/.git
     Also skip: .env, *.pem, credentials.* (same exclusions as hooks)
  5. Prioritize: entry points and core files first
     - Tier 1: CLAUDE.md, README.md, package.json, Cargo.toml, go.mod, pyproject.toml
     - Tier 2: src/**/index.*, src/**/main.*, app/**/route.*
     - Tier 3: src/**/*.{ts,py,go,rs,js}, lib/**/*
     - Tier 4: tests/**/*
  6. Cap: max 500 files per run (configurable via --max-files)
     If more files exist, select the most recently modified 500 (via git log)
  7. For each file:
     - Read contents (directly, not through Claude Code)
     - Generate a synthetic PostToolUse-shaped event:
       { type: "PostToolUse", session_id: learn_id, cwd: project_path,
         tool: "Read", input: { file_path }, output: { content } }
     - Send to worker via socket for normal pipeline processing
  8. Progress bar: [=====>        ] 127/500 files (25%)
  9. Wait for worker to drain:
     → Send a control message (NOT a pipeline event): `{ type: "control", action: "drain_complete", session_id: learn_id }`
     → The worker event loop recognizes `type: "control"` messages and handles them directly without routing through the classify/normalize/extract pipeline. For `drain_complete`, the worker responds with `{ type: "control_ack", action: "drain_complete", pending: 0 }` once all queued events for that session have been processed.
     → The learn CLI waits up to 30s for the `control_ack`, polling every 500ms. If the ack isn't received within 30s, it proceeds anyway (events will still be processed eventually).
  10. Finalize session directly in DB (learn has write access, same as install/compact):
     → Query observation titles for this session: SELECT title FROM observations WHERE session_id = learn_id ORDER BY significance DESC LIMIT 5
     → Build summary using Tier 0 heuristic: "Session covered: <title1>, <title2>, ..."
     → UPDATE sessions SET ended_at_epoch = now(), summary = <generated> WHERE id = learn_id
     → The learn process generates the summary directly — it does NOT send a Stop event to the worker.
       This avoids the request-response complexity and is consistent with how SessionStart reads the DB directly.
  11. Summary: "Learned 500 files → 340 observations (160 skipped as low-signal)"
```

**Why CLI and not a skill:** A skill runs inside the agent's session. Reading 500 files through the Read tool would:
- Consume the entire context window after ~50 files
- Trigger Claude Code's context compaction repeatedly
- Take 30+ minutes instead of 3-5 minutes
- Generate inferior observations (the agent processes one file at a time with no batching)

The CLI command reads files directly, sends synthetic events to the pipeline, and finishes in ~3-5 minutes. The agent can then search the resulting observations via MCP tools.

**The `/deja-learn` skill still exists** but it simply tells the agent: "Run `npx deja learn` in the terminal to front-load codebase memory. This reads files directly — much faster than reading them one by one."

## Stats & Observability

Users should be able to understand what deja is doing and how much value it provides.

Stats are tracked in the `stats` table — a simple key-value counter per project. The **pipeline orchestrator** (not the classifier itself — the classifier is a pure function that returns a classification) increments `events_skipped` when the classifier returns SKIP, and `events_processed` when an observation is stored after the full pipeline completes. The SessionStart hook increments `context_injections` and adds the actual character count to `context_chars_total` on each injection (for computing average budget utilization). Counters use upsert: `INSERT INTO stats (project, metric, value) VALUES (?, ?, 1) ON CONFLICT(project, metric) DO UPDATE SET value = value + 1` — one atomic SQL statement, negligible overhead. The `context_chars_total` metric uses the same upsert pattern but with the actual character count instead of 1: `INSERT INTO stats (project, metric, value) VALUES (?, 'context_chars_total', ?) ON CONFLICT(project, metric) DO UPDATE SET value = value + excluded.value`. Average budget utilization is computed as `context_chars_total / context_injections`.

### Stats Command

```bash
npx deja stats
```

Output:

```
deja stats — ibkr-mcp-server
─────────────────────────────

Sessions:          47 (first: 2026-05-22, latest: today)
Observations:     1,247
  critical:          23
  high:             156
  medium:           842
  low:              226
Events skipped:    580 (31.7%)

Storage:          4.2 MB (memory.db)
WAL:              0 bytes (healthy)

Tiers active:     FTS5 ✓  AST ✗  Vectors ✗  LLM ✗
Worker:           running (PID 12847, uptime 2h 14m)

Context injections: 47 sessions
  Avg budget used:  6,240 / 8,000 chars (78%)

Cross-projects:    3 projects tracked
```

### `--all` Flag

```bash
npx deja stats --all
```

Shows aggregate stats across all projects, plus a per-project breakdown table:

```
Project                    Sessions  Observations
ibkr-mcp-server                 47         1,247
trading-bot                     12           340
personal-site                    5            89
──────────────────────────────────────────────────
Total                           64         1,676

Storage: 5.6 MB (memory.db — shared across all projects)
```

Per-project storage breakdown is not shown because all projects share a single SQLite file. Total DB size is reported once at the bottom.

## Dashboard Lifecycle

The dashboard runs as a **separate Bun process** from the worker, not embedded in it.

### Why Separate

1. **Worker is headless.** It processes observations and serves the MCP socket. Adding HTTP routes to the worker increases its surface area and makes it harder to reason about shutdown/idle timeout.
2. **Dashboard is optional.** Most users interact with deja through CLI and agent context injection. The dashboard is for exploration and debugging — it shouldn't affect the worker's resource footprint.
3. **Independent lifecycle.** The dashboard can be started and stopped without affecting observation processing. The worker can idle-timeout and shut down while the dashboard remains open (it reads directly from SQLite, which doesn't require the worker).

### How It Works

```
npx deja dashboard
  → Spawns a Bun process: bun ./dist/dashboard/server.js
  → Opens http://localhost:3333 in default browser
  → Process reads memory.db directly (read-only, WAL mode allows concurrent access)
  → Ctrl+C or close terminal → dashboard process exits
  → Worker is unaffected
```

The dashboard process is NOT detached — it runs in the foreground of the terminal that launched it. This is intentional: users expect `Ctrl+C` to stop a dashboard, and detached dashboard processes are a source of "why is port 3333 in use?" bugs.

If port 3333 is already in use, the dashboard tries ports 3334-3343 in sequence. If all 10 ports are taken, it exits with an error suggesting `--port`.

If the worker is not running, the dashboard still works — it just shows the last known state from the database.

## Memory Replay

Replay a past session's observations as if you're watching it happen — useful for understanding what the agent did and why.

### Command

```bash
npx deja replay --session <session-id>
npx deja replay --session <session-id> --format markdown  # Default
npx deja replay --session <session-id> --format json      # Machine-readable
```

### Output (Markdown, default)

```markdown
# Session Replay: ibkr-mcp-server
**Date:** May 22, 2026 10:15 PM — 11:42 PM
**Observations:** 24  **Significance:** 2 critical, 5 high, 14 medium, 3 low

---

## Session Summary
Designed deja persistent memory plugin. Decided on micro-kernel + pipeline
architecture, single SQLite file, heuristic-first extraction.

---

### 10:15 PM ● CRITICAL — Created design spec
**Kind:** file_edit  **Files:** docs/superpowers/specs/2026-05-22-deja-design.md
**Content:** Wrote initial design spec for deja plugin...
**Facts:** ["Chose micro-kernel + pipeline architecture", "SQLite as single storage"]
**Concepts:** ["architecture", "design", "sqlite", "memory"]

### 10:23 PM ● HIGH — Added SQLite schema with FTS5 triggers
...

### 10:31 PM ○ MEDIUM — Read claude-mem hooks.json
...
```

### Use Cases

- **Post-session review:** "What did the agent do while I was away?"
- **Onboarding:** Show a new team member what the AI agent learned about the codebase
- **Debugging:** Understand why the agent made a specific decision by replaying the session that led to it

### JSON Output (`--format json`)

```json
{
  "session_id": "abc123",
  "project": "ibkr-mcp-server",
  "started_at_epoch": 1716415200000,
  "ended_at_epoch": 1716420120000,
  "summary": "Designed deja persistent memory plugin. Decided on micro-kernel + pipeline architecture, single SQLite file, heuristic-first extraction.",
  "observations": [
    {
      "id": 1042,
      "created_at_epoch": 1716415200000,
      "significance": "critical",
      "kind": "file_edit",
      "title": "Created design spec",
      "content": "Wrote initial design spec for deja plugin...",
      "facts": ["Chose micro-kernel + pipeline architecture", "SQLite as single storage"],
      "concepts": ["architecture", "design", "sqlite", "memory"],
      "files_read": [],
      "files_modified": ["docs/superpowers/specs/2026-05-22-deja-design.md"]
    }
  ],
  "stats": {
    "total": 24,
    "by_significance": { "critical": 2, "high": 5, "medium": 14, "low": 3 }
  }
}
```

**JSON date convention:** All JSON output (CLI `--format json`, MCP tool responses, export files) uses epoch milliseconds for timestamps — matching the database schema. Human-readable formats (CLI default text, dashboard, replay markdown) derive display dates via `datetime(epoch/1000, 'unixepoch')`. One convention, no ambiguity.

## Memory Diff

Compare what the agent knew at two different points in time — useful for understanding how understanding evolved or what was learned between sessions.

### Command

```bash
# Compare two sessions
npx deja diff --session1 <id1> --session2 <id2>

# Compare a project across a date range
npx deja diff --project /path --before 2026-05-01 --after 2026-05-22

# Output as JSON
npx deja diff --session1 <id1> --session2 <id2> --format json
```

### Output

```
Memory Diff: ibkr-mcp-server
Session A: May 20, 2026 (38 observations)
Session B: May 22, 2026 (24 observations)

NEW CONCEPTS (appeared in B, not in A):
  + deja, memory, plugin-architecture, sqlite-vec, fts5

EVOLVED CONCEPTS (present in both, with new observations):
  + architecture: 2 new critical observations
  + testing: 1 new high observation (test strategy added)

DISAPPEARED CONCEPTS (in A, not in B):
  - chrome-extension, popup-ui  (different project focus)

NEW FILES TOUCHED:
  + docs/superpowers/specs/2026-05-22-deja-design.md (created)
  + ibkr_mcp_server/tools/admin.py (modified)

KEY DECISIONS (critical observations unique to each):
  Session A: "Chose WebSocket over SSE for real-time updates"
  Session B: "Chose micro-kernel + pipeline architecture for deja"
```

### Algorithm

Both modes work on the same core logic — they differ only in how they select the two observation sets to compare:

- **Session mode** (`--session1 <id1> --session2 <id2>`): Set A = all observations in session 1. Set B = all observations in session 2.
- **Date range mode** (`--project /path --before <date> --after <date>`): Set A = all observations for the project before the date. Set B = all observations for the project on/after the date. The output labels them as "Before <date>" and "After <date>" instead of "Session A/B". **Accepted date formats:** `YYYY-MM-DD` (e.g., `2026-05-01`) or relative durations (`7d`, `30d`, `6m` — same format as `export --since`). Relative dates are resolved to absolute dates at command execution time. Invalid formats produce an error with examples.

**Diff computation (same for both modes):**

1. **Concept sets:** Extract unique concepts from each set. `new = B_concepts - A_concepts`. `disappeared = A_concepts - B_concepts`. `shared = A_concepts ∩ B_concepts`.
2. **Evolved concepts:** For each concept in `shared`, count observations in B that reference it. If count > 0, it's "evolved" — report the count and max significance.
3. **Files touched:** Union of `files_read` + `files_modified` from each set. Report files in B not in A as "new files touched."
4. **Key decisions:** Filter each set for `significance = critical`. List their titles, one per session/period.
5. **Stats header:** Observation count and date range for each set.

No LLM required — the diff is purely structural (set operations on concepts, files, and significance filters). Works at Tier 0.

### JSON Output (`--format json`)

```json
{
  "set_a": { "label": "Session A", "id": "abc123", "observation_count": 38, "date_range": [1716200000000, 1716220000000] },
  "set_b": { "label": "Session B", "id": "xyz789", "observation_count": 24, "date_range": [1716400000000, 1716420000000] },
  "new_concepts": ["deja", "memory", "plugin-architecture", "sqlite-vec", "fts5"],
  "disappeared_concepts": ["chrome-extension", "popup-ui"],
  "evolved_concepts": [
    { "concept": "architecture", "new_observations": 2, "max_significance": "critical" },
    { "concept": "testing", "new_observations": 1, "max_significance": "high" }
  ],
  "new_files": ["docs/superpowers/specs/2026-05-22-deja-design.md"],
  "key_decisions": {
    "set_a": ["Chose WebSocket over SSE for real-time updates"],
    "set_b": ["Chose micro-kernel + pipeline architecture for deja"]
  }
}
```

### Use Cases

- **Progress tracking:** "What did we learn this week vs last week?"
- **Knowledge drift detection:** Concepts that disappear may indicate abandoned work
- **Code review context:** Before reviewing a PR, diff the sessions that produced it to understand the agent's reasoning

## Auto CLAUDE.md Generation

Generates a CLAUDE.md file from deja's accumulated memory — bootstrapping project documentation from what the agent actually learned.

### Command

```bash
# Generate for current project
npx deja generate-claude-md

# Preview without writing
npx deja generate-claude-md --dry-run

# Specify output (default: ./CLAUDE.md)
npx deja generate-claude-md --output ./docs/CLAUDE.md

# Include observations from the last N days only
npx deja generate-claude-md --since 30d
```

### How It Works

1. **Gather high-signal data:** Pulls all `critical` and `high` significance observations for the project, plus session summaries.
2. **Extract patterns:**
   - **Architecture:** From file_edit observations on core modules — identifies the layered structure, key components, data flow.
   - **Common commands:** From bash_cmd observations — identifies frequently used commands (test runners, build commands, linters).
   - **Key decisions:** From critical observations — surfaces architectural decisions and their rationale.
   - **File structure:** From file_read patterns — identifies which directories contain what kind of code.
3. **Generate sections:** Assembles a CLAUDE.md with standard sections:
   - Project Overview (from session summaries)
   - Architecture (from structural observations)
   - Common Commands (from bash patterns)
   - Key Decisions (from critical observations, with rationale)
   - Testing (from test-related observations)
4. **Format and write:** Outputs clean markdown. If a CLAUDE.md already exists, shows a diff and asks for confirmation before overwriting.

### Requirements

- Requires **Tier 3 (LLM)** to be enabled — the generation uses the configured LLM to synthesize observations into coherent prose.
- With Tier 0/1 only, the command outputs a structured but less narrative version: bullet points of extracted facts grouped by section, rather than flowing paragraphs. Section assignment uses the observation's `kind` and file paths: `bash_cmd` observations matching test runner patterns → "Testing"; `bash_cmd` matching build/lint/format → "Common Commands"; `file_edit` or `file_write` on core source files → "Architecture"; `kind=decision` → "Key Decisions"; `kind=prompt` → "Key Decisions" (user prompts that expressed intent); everything else → "Notes". Not as good as LLM synthesis, but produces a useful starting point.
- Minimum 10 `high`+ observations required — if the project has fewer, the command suggests running more sessions first.

### Why This Matters

Most CLAUDE.md files are written once and slowly rot. By generating from live memory, the documentation reflects what the agent actually encounters — not what someone thought was important six months ago. Re-run periodically to keep it fresh.

## Project Metadata

- **Name:** deja
- **Tagline:** "Your agent never forgets."
- **License:** Apache 2.0
- **Runtime:** Bun (>= 1.3.6)
- **Language:** TypeScript (strict)
- **Package:** npm (`npx deja install`)
- **Storage:** Single SQLite file at `~/.deja/memory.db`
- **Platforms:** macOS, Linux, Windows
