# Plan 2: Ingest Pipeline — Classify, Normalize, Debounce

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first two pipeline stages (classify + normalize) and the debouncer. After this plan, raw hook payloads can be classified by significance, normalized into a consistent shape, and batched via debounce — all as pure functions with full test coverage.

**Architecture:** Each pipeline stage is a pure function: input → output, zero side effects, independently testable without mocking. The debouncer is the one stateful component — it holds a per-session timer and event buffer. The classifier reads `_batch` annotations set by the debouncer but does not interact with it directly.

**Tech Stack:** Bun >= 1.3.6, TypeScript (strict), bun:test

**Spec:** `docs/superpowers/specs/2026-05-22-deja-design.md` (lines 604-955)

**Plan series:**
1. ~~Kernel~~ (done) — db, migrations, settings, lock, logging, shared types
2. **Ingest Pipeline** (this plan) — classify, normalize, debounce
3. Heuristic Extract + FTS Index
4. WAL + Socket + Worker (IPC, event queue, main loop, timers)
5. Hook Shims (4 hooks)
6. Context Injection (SessionStart generator)
7. MCP Server (4 tools)
8. CLI Commands (install, status, search, learn, stats, etc.)
9. Dashboard

---

## File Structure

```
src/
├── types.ts                          # (exists) — add ClassifyResult, ClassifyInput
├── pipelines/
│   └── ingest/
│       ├── classify.ts               # classify(payload, recentCommands) → ClassifyResult
│       ├── normalize.ts              # normalize(payload) → NormalizedEvent
│       └── debounce.ts               # Debouncer class — buffers events per session, emits batches
tests/
├── pipelines/
│   └── ingest/
│       ├── classify.test.ts
│       ├── normalize.test.ts
│       └── debounce.test.ts
```

---

## Chunk 1: Classifier

### Task 1: Add ClassifyResult and ClassifyInput types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add ClassifyResult and ClassifyInput to types.ts**

Append these types after the existing `StatRow` interface:

```typescript
export interface ClassifyResult {
  significance: Significance;
  rule: string;
}

export interface ClassifyInput {
  payload: HookPayload;
  recentCommands: Set<string>;
  seenWritePaths: Set<string>;
  settings: Pick<Settings, "excluded_projects">;
  batch?: BatchAnnotation;
}
```

`ClassifyResult.rule` is a human-readable label for the matching rule (e.g., `"noise_file_read"`, `"decision_prompt"`). Used for debugging and stats, not pipeline logic.

`ClassifyInput.recentCommands` is a per-session set of `"command:timestamp"` strings for dedup within 60s. The caller (worker) manages the set lifecycle; the classifier only reads it.

`ClassifyInput.seenWritePaths` is a per-session set of file paths that have already been Written to. The classifier checks this to distinguish first-Write (new file → CRITICAL) from subsequent Writes (rewrite → default MEDIUM). The caller manages the set; the classifier only reads it.

- [ ] **Step 2: Verify types compile**

Run: `bun x tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add ClassifyResult and ClassifyInput types for pipeline"
```

---

### Task 2: Write failing tests for classify.ts

**Files:**
- Create: `tests/pipelines/ingest/classify.test.ts`

- [ ] **Step 1: Write classifier tests**

The classifier has 15 rules evaluated top-to-bottom (first match wins). Tests verify each rule, the default, and rule priority.

```typescript
import { describe, test, expect } from "bun:test";
import { classify } from "../../../src/pipelines/ingest/classify";
import type { HookPayload, BatchAnnotation, ClassifyInput } from "../../../src/types";

function input(
  payload: HookPayload,
  opts: { recentCommands?: Set<string>; seenWritePaths?: Set<string>; excludedProjects?: string[]; batch?: BatchAnnotation } = {}
): ClassifyInput {
  return {
    payload,
    recentCommands: opts.recentCommands ?? new Set(),
    seenWritePaths: opts.seenWritePaths ?? new Set(),
    settings: { excluded_projects: opts.excludedProjects ?? [] },
    batch: opts.batch,
  };
}

function postToolUse(tool: string, inp: Record<string, unknown>, out: Record<string, unknown> = {}): HookPayload {
  return { type: "PostToolUse", session_id: "s1", cwd: "/project", tool, input: inp, output: out };
}

describe("classify", () => {
  // --- SKIP rules ---

  test("SKIP: excluded project", () => {
    const payload: HookPayload = { type: "PostToolUse", session_id: "s1", cwd: "/secret/repo", tool: "Read", input: { file_path: "/secret/repo/foo.ts" }, output: {} };
    const result = classify(input(payload, { excludedProjects: ["/secret/repo"] }));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("excluded_project");
  });

  test("SKIP: noise file read — node_modules", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/node_modules/foo/index.js" }, { content: "..." })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("noise_file_read");
  });

  test("SKIP: noise file read — .git directory", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/.git/config" }, { content: "..." })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("noise_file_read");
  });

  test("SKIP: noise file read — lock files", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/package-lock.json" }, { content: "..." })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("noise_file_read");
  });

  test("SKIP: noise file read — dist directory", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/dist/bundle.js" }, { content: "..." })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("noise_file_read");
  });

  test("SKIP: noise file extension — .map", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/src/app.js.map" }, { content: "..." })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("noise_file_extension");
  });

  test("SKIP: noise file extension — .min.js", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/vendor/lib.min.js" }, { content: "..." })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("noise_file_extension");
  });

  test("SKIP: duplicate bash command within 60s", () => {
    const recent = new Set(["pytest tests/:1700000000000"]);
    const now = 1700000030000; // 30s later — within 60s window
    const payload = postToolUse("Bash", { command: "pytest tests/" }, { stdout: "", stderr: "", exit_code: 0 });
    const result = classify(input(payload, { recentCommands: recent }), now);
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("duplicate_bash");
  });

  test("does NOT skip bash command if older than 60s", () => {
    const recent = new Set(["pytest tests/:1700000000000"]);
    const now = 1700000070000; // 70s later — outside 60s window
    const payload = postToolUse("Bash", { command: "pytest tests/" }, { stdout: "", stderr: "", exit_code: 0 });
    const result = classify(input(payload, { recentCommands: recent }), now);
    expect(result.significance).not.toBe("skip");
  });

  test("SKIP: navigation commands", () => {
    for (const cmd of ["ls", "pwd", "cd src", "echo $PATH", "which node", "type git"]) {
      const result = classify(input(postToolUse("Bash", { command: cmd }, { stdout: "", stderr: "", exit_code: 0 })));
      expect(result.significance).toBe("skip");
      expect(result.rule).toBe("navigation_command");
    }
  });

  test("SKIP: credential files", () => {
    for (const path of ["/project/.env", "/project/.env.local", "/project/server.pem", "/project/server.key", "/project/credentials.json", "/project/config/.secrets.yaml"]) {
      const result = classify(input(postToolUse("Read", { file_path: path }, { content: "..." })));
      expect(result.significance).toBe("skip");
      expect(result.rule).toBe("credential_file");
    }
  });

  // --- CRITICAL rules ---

  test("CRITICAL: dependency file changed", () => {
    for (const path of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "requirements.txt", "Gemfile"]) {
      const result = classify(input(postToolUse("Edit", { file_path: `/project/${path}`, old_string: "a", new_string: "b" }, { success: true })));
      expect(result.significance).toBe("critical");
      expect(result.rule).toBe("dependency_file_changed");
    }
  });

  test("CRITICAL: decision in prompt", () => {
    for (const phrase of ["let's use Redis", "switch to PostgreSQL", "we should refactor", "decided to go with SSR", "choosing WebSockets", "going with approach B"]) {
      const payload: HookPayload = { type: "UserPromptSubmit", session_id: "s1", cwd: "/project", prompt: phrase };
      const result = classify(input(payload));
      expect(result.significance).toBe("critical");
      expect(result.rule).toBe("decision_prompt");
    }
  });

  test("non-decision prompt is MEDIUM (default)", () => {
    const payload: HookPayload = { type: "UserPromptSubmit", session_id: "s1", cwd: "/project", prompt: "fix the bug in login.ts" };
    const result = classify(input(payload));
    expect(result.significance).toBe("medium");
  });

  // --- HIGH rules ---

  test("HIGH: multi-file edit batch", () => {
    const batch: BatchAnnotation = { batch_size: 3, batch_index: 0, multi_file_edit: true, unique_files: ["a.ts", "b.ts"] };
    const result = classify(input(postToolUse("Edit", { file_path: "/project/a.ts", old_string: "a", new_string: "b" }, { success: true }), { batch }));
    expect(result.significance).toBe("high");
    expect(result.rule).toBe("multi_file_edit");
  });

  test("HIGH: test failure", () => {
    const result = classify(input(postToolUse("Bash", { command: "bun test" }, { stdout: "3 fail", stderr: "", exit_code: 1 })));
    expect(result.significance).toBe("high");
    expect(result.rule).toBe("test_failure");
  });

  test("HIGH: error debugging — long stderr", () => {
    const longStderr = "E".repeat(201);
    const result = classify(input(postToolUse("Bash", { command: "node server.js" }, { stdout: "", stderr: longStderr, exit_code: 1 })));
    expect(result.significance).toBe("high");
    expect(result.rule).toBe("error_debugging");
  });

  // --- LOW rules ---

  test("LOW: config file read", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/tsconfig.json" }, { content: "{}" })));
    expect(result.significance).toBe("low");
    expect(result.rule).toBe("config_file_read");
  });

  test("LOW: simple grep with short output", () => {
    const result = classify(input(postToolUse("Bash", { command: "grep -r 'TODO' src/" }, { stdout: "src/a.ts:TODO fix", stderr: "", exit_code: 0 })));
    expect(result.significance).toBe("low");
    expect(result.rule).toBe("simple_grep");
  });

  // --- DEFAULT ---

  test("MEDIUM: default for unmatched events", () => {
    const result = classify(input(postToolUse("Edit", { file_path: "/project/src/app.ts", old_string: "a", new_string: "b" }, { success: true })));
    expect(result.significance).toBe("medium");
    expect(result.rule).toBe("default");
  });

  // --- Priority ---

  test("credential file SKIP takes priority over config LOW", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/.env.production" }, { content: "SECRET=abc" })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("credential_file");
  });

  test("dependency Edit is CRITICAL even if it's a config file", () => {
    const result = classify(input(postToolUse("Edit", { file_path: "/project/package.json", old_string: "a", new_string: "b" }, { success: true })));
    expect(result.significance).toBe("critical");
    expect(result.rule).toBe("dependency_file_changed");
  });

  // --- new_source_file edge cases (PE review findings #1, #2) ---

  test("CRITICAL: new source file — first Write to path is CRITICAL", () => {
    const result = classify(input(postToolUse("Write", { file_path: "/project/src/new-module.ts", content: "export class Foo {}" }, { success: true }), { seenWritePaths: new Set() }));
    expect(result.significance).toBe("critical");
    expect(result.rule).toBe("new_source_file");
  });

  test("subsequent Write to same path is MEDIUM (default), not CRITICAL", () => {
    const seen = new Set(["/project/src/new-module.ts"]);
    const result = classify(input(postToolUse("Write", { file_path: "/project/src/new-module.ts", content: "export class Foo { updated }" }, { success: true }), { seenWritePaths: seen }));
    expect(result.significance).toBe("medium");
    expect(result.rule).toBe("default");
  });

  test("Write to dist/ is NOT critical (not a source dir or project root file)", () => {
    const result = classify(input(postToolUse("Write", { file_path: "/project/dist/output.js", content: "bundled" }, { success: true })));
    expect(result.significance).toBe("medium");
    expect(result.rule).toBe("default");
  });

  test("Write to project root file (no subdirectory) IS critical", () => {
    const result = classify(input(postToolUse("Write", { file_path: "/project/Dockerfile", content: "FROM node:20" }, { success: true })));
    expect(result.significance).toBe("critical");
    expect(result.rule).toBe("new_source_file");
  });

  // --- credential false-positive guard (PE review finding #3) ---

  test("src/secret-rotation.ts is NOT skipped as credential file", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/src/secret-rotation.ts" }, { content: "..." })));
    expect(result.significance).not.toBe("skip");
  });

  // --- SessionStart / Stop ---

  test("SessionStart is SKIP (lifecycle event, not stored)", () => {
    const payload: HookPayload = { type: "SessionStart", session_id: "s1", cwd: "/project", trigger: "startup" };
    const result = classify(input(payload));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("session_lifecycle");
  });

  test("Stop is SKIP (lifecycle event, not stored)", () => {
    const payload: HookPayload = { type: "Stop", session_id: "s1", cwd: "/project" };
    const result = classify(input(payload));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("session_lifecycle");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/pipelines/ingest/classify.test.ts`
Expected: FAIL — `classify` not found

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/pipelines/ingest/classify.test.ts
git commit -m "test: add failing tests for ingest classifier (25 cases)"
```

---

### Task 3: Implement classify.ts

**Files:**
- Create: `src/pipelines/ingest/classify.ts`

- [ ] **Step 1: Implement classify**

```typescript
import type { ClassifyInput, ClassifyResult } from "../../types";

const NOISE_PATH_PATTERNS = [
  /node_modules\//,
  /\.git\//,
  /-lock\.json$/,
  /\.lock$/,
  /dist\//,
  /build\//,
  /\.next\//,
];

const NOISE_EXTENSIONS = [/\.map$/, /\.min\.js$/, /\.min\.css$/];

const NAV_COMMANDS = /^(ls|pwd|cd|echo \$|which|type|cat <<<)/;

const CREDENTIAL_PATTERNS = [
  /\.env($|\.)/,
  /\.pem$/,
  /\.key$/,
  /credentials\./,
  /[\\/]\.?secrets?\./, // matches filename starting with "secret." or "secrets." or ".secret." — not arbitrary paths containing the word
];

const DEPENDENCY_FILES = new Set([
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "requirements.txt",
  "Gemfile",
]);

const DECISION_PATTERNS = /\b(let'?s use|switch to|we should|decided to|choosing|going with)\b/i;

const TEST_COMMANDS = /pytest|jest|vitest|cargo test|go test|npm test|bun test/;

const SEARCH_COMMANDS = /^(grep|find|rg|ag|fd) /;

const SOURCE_DIRS = /\/(src|lib|app)\//;

const CONFIG_EXTENSIONS = /\.(json|yaml|yml|toml|ini|cfg)$/;

function basename(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? filePath : filePath.slice(i + 1);
}

export function classify(input: ClassifyInput, now: number = Date.now()): ClassifyResult {
  const { payload, recentCommands, seenWritePaths, settings, batch } = input;
  const tool = (payload as any).tool as string | undefined;
  const filePath = ((payload as any).input?.file_path ?? "") as string;
  const command = ((payload as any).input?.command ?? "") as string;
  const stdout = ((payload as any).output?.stdout ?? "") as string;
  const stderr = ((payload as any).output?.stderr ?? "") as string;
  const exitCode = ((payload as any).output?.exit_code ?? 0) as number;
  const prompt = ((payload as any).prompt ?? "") as string;

  // --- SessionStart / Stop: lifecycle events, not stored ---
  if (payload.type === "SessionStart" || payload.type === "Stop") {
    return { significance: "skip", rule: "session_lifecycle" };
  }

  // --- SKIP: excluded project ---
  if (settings.excluded_projects.some((p) => payload.cwd.startsWith(p))) {
    return { significance: "skip", rule: "excluded_project" };
  }

  // --- SKIP: noise file read ---
  if (tool === "Read" && NOISE_PATH_PATTERNS.some((p) => p.test(filePath))) {
    return { significance: "skip", rule: "noise_file_read" };
  }

  // --- SKIP: noise file extension ---
  if (tool === "Read" && NOISE_EXTENSIONS.some((p) => p.test(filePath))) {
    return { significance: "skip", rule: "noise_file_extension" };
  }

  // --- SKIP: duplicate bash command within 60s ---
  if (tool === "Bash" && command) {
    for (const entry of recentCommands) {
      const sep = entry.lastIndexOf(":");
      const cmd = entry.slice(0, sep);
      const ts = parseInt(entry.slice(sep + 1), 10);
      if (cmd === command && now - ts < 60_000) {
        return { significance: "skip", rule: "duplicate_bash" };
      }
    }
  }

  // --- SKIP: navigation commands ---
  if (tool === "Bash" && NAV_COMMANDS.test(command)) {
    return { significance: "skip", rule: "navigation_command" };
  }

  // --- SKIP: credential files ---
  if (filePath && CREDENTIAL_PATTERNS.some((p) => p.test(filePath))) {
    return { significance: "skip", rule: "credential_file" };
  }

  // --- CRITICAL: new source file created (first Write to path in session) ---
  if (tool === "Write" && !seenWritePaths.has(filePath)) {
    const isSourceDir = SOURCE_DIRS.test(filePath);
    const relPath = filePath.startsWith(payload.cwd + "/") ? filePath.slice(payload.cwd.length + 1) : "";
    const isProjectRootFile = relPath !== "" && !relPath.includes("/");
    if (isSourceDir || isProjectRootFile) {
      return { significance: "critical", rule: "new_source_file" };
    }
  }

  // --- CRITICAL: dependency file changed ---
  if (tool === "Edit" && DEPENDENCY_FILES.has(basename(filePath))) {
    return { significance: "critical", rule: "dependency_file_changed" };
  }

  // --- CRITICAL: decision in prompt ---
  if (payload.type === "UserPromptSubmit" && DECISION_PATTERNS.test(prompt)) {
    return { significance: "critical", rule: "decision_prompt" };
  }

  // --- HIGH: multi-file edit batch ---
  if (batch?.multi_file_edit) {
    return { significance: "high", rule: "multi_file_edit" };
  }

  // --- HIGH: test failure ---
  if (
    tool === "Bash" &&
    exitCode !== 0 &&
    (TEST_COMMANDS.test(command) || /failed|FAIL|error/i.test(stdout))
  ) {
    return { significance: "high", rule: "test_failure" };
  }

  // --- HIGH: error debugging ---
  if (tool === "Bash" && exitCode !== 0 && stderr.length > 200) {
    return { significance: "high", rule: "error_debugging" };
  }

  // --- LOW: config file read ---
  if (tool === "Read" && CONFIG_EXTENSIONS.test(filePath)) {
    return { significance: "low", rule: "config_file_read" };
  }

  // --- LOW: simple grep/find ---
  if (tool === "Bash" && SEARCH_COMMANDS.test(command) && stdout.length < 500) {
    return { significance: "low", rule: "simple_grep" };
  }

  // --- MEDIUM: default ---
  return { significance: "medium", rule: "default" };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test tests/pipelines/ingest/classify.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/pipelines/ingest/classify.ts
git commit -m "feat: implement event classifier with 15 significance rules"
```

---

## Chunk 2: Normalizer

### Task 4: Write failing tests for normalize.ts

**Files:**
- Create: `tests/pipelines/ingest/normalize.test.ts`

- [ ] **Step 1: Write normalizer tests**

```typescript
import { describe, test, expect } from "bun:test";
import { normalize } from "../../../src/pipelines/ingest/normalize";
import type { HookPayload } from "../../../src/types";

function postToolUse(tool: string, inp: Record<string, unknown>, out: Record<string, unknown> = {}): HookPayload {
  return { type: "PostToolUse", session_id: "s1", cwd: "/project", tool, input: inp, output: out };
}

describe("normalize", () => {
  // --- Edit ---

  test("Edit: formats diff with file path, old, new", () => {
    const result = normalize(postToolUse("Edit", {
      file_path: "/project/src/app.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    }, { success: true }));
    expect(result.tool).toBe("Edit");
    expect(result.files).toEqual(["/project/src/app.ts"]);
    expect(result.action).toBe("edit");
    expect(result.content_summary).toContain("EDIT /project/src/app.ts");
    expect(result.content_summary).toContain("--- old");
    expect(result.content_summary).toContain("const x = 1;");
    expect(result.content_summary).toContain("+++ new");
    expect(result.content_summary).toContain("const x = 2;");
  });

  test("Edit: truncates old_string and new_string to 900 chars each", () => {
    const longOld = "a\n".repeat(500); // 1000 chars
    const longNew = "b\n".repeat(500);
    const result = normalize(postToolUse("Edit", {
      file_path: "/project/src/big.ts",
      old_string: longOld,
      new_string: longNew,
    }, { success: true }));
    expect(result.content_summary.length).toBeLessThanOrEqual(2000);
  });

  // --- Write ---

  test("Write: formats with file path and content from input", () => {
    const result = normalize(postToolUse("Write", {
      file_path: "/project/src/new.ts",
      content: "export function hello() { return 'world'; }",
    }, { success: true }));
    expect(result.tool).toBe("Write");
    expect(result.files).toEqual(["/project/src/new.ts"]);
    expect(result.action).toBe("write");
    expect(result.content_summary).toContain("WRITE /project/src/new.ts");
    expect(result.content_summary).toContain("export function hello()");
  });

  test("Write: uses input.content, not output", () => {
    const result = normalize(postToolUse("Write", {
      file_path: "/project/src/new.ts",
      content: "the actual content",
    }, { success: true }));
    expect(result.content_summary).toContain("the actual content");
    expect(result.content_summary).not.toContain("success");
  });

  // --- Read ---

  test("Read: formats with file path and content from output", () => {
    const result = normalize(postToolUse("Read", {
      file_path: "/project/src/client.py",
    }, { content: "import asyncio\n\nclass IBKRClient:\n    pass" }));
    expect(result.tool).toBe("Read");
    expect(result.files).toEqual(["/project/src/client.py"]);
    expect(result.action).toBe("read");
    expect(result.content_summary).toContain("READ /project/src/client.py");
    expect(result.content_summary).toContain("import asyncio");
  });

  test("Read: uses output.content, not input", () => {
    const result = normalize(postToolUse("Read", {
      file_path: "/project/src/client.py",
    }, { content: "file contents here" }));
    expect(result.content_summary).toContain("file contents here");
  });

  // --- Bash ---

  test("Bash: formats command, stdout, stderr", () => {
    const result = normalize(postToolUse("Bash", {
      command: "pytest tests/ -v",
    }, { stdout: "42 passed, 3 failed", stderr: "DeprecationWarning", exit_code: 1 }));
    expect(result.tool).toBe("Bash");
    expect(result.files).toEqual([]);
    expect(result.action).toBe("bash");
    expect(result.content_summary).toContain("BASH $ pytest tests/ -v");
    expect(result.content_summary).toContain("42 passed, 3 failed");
    expect(result.content_summary).toContain("DeprecationWarning");
  });

  test("Bash: prioritizes stdout over stderr when truncating", () => {
    const longStdout = "out\n".repeat(600); // ~2400 chars
    const longStderr = "err\n".repeat(600);
    const result = normalize(postToolUse("Bash", {
      command: "make build",
    }, { stdout: longStdout, stderr: longStderr, exit_code: 0 }));
    expect(result.content_summary.length).toBeLessThanOrEqual(2000);
    expect(result.content_summary).toContain("out");
  });

  // --- UserPromptSubmit ---

  test("UserPromptSubmit: formats prompt text", () => {
    const payload: HookPayload = {
      type: "UserPromptSubmit",
      session_id: "s1",
      cwd: "/project",
      prompt: "Fix the rate limiting bug in client.py",
    };
    const result = normalize(payload);
    expect(result.tool).toBeNull();
    expect(result.action).toBe("prompt");
    expect(result.content_summary).toContain("PROMPT Fix the rate limiting bug");
  });

  // --- SessionStart ---

  test("SessionStart: formats with project and trigger", () => {
    const payload: HookPayload = {
      type: "SessionStart",
      session_id: "s1",
      cwd: "/Users/alice/projects/my-app",
      trigger: "startup",
    };
    const result = normalize(payload);
    expect(result.tool).toBeNull();
    expect(result.action).toBe("session_start");
    expect(result.content_summary).toBe("SESSION_START project=/Users/alice/projects/my-app trigger=startup");
  });

  // --- Stop ---

  test("Stop: formats with project", () => {
    const payload: HookPayload = {
      type: "Stop",
      session_id: "s1",
      cwd: "/Users/alice/projects/my-app",
    };
    const result = normalize(payload);
    expect(result.tool).toBeNull();
    expect(result.action).toBe("session_end");
    expect(result.content_summary).toBe("SESSION_END project=/Users/alice/projects/my-app");
  });

  // --- Truncation behavior ---

  test("truncation cuts at last complete line", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${"x".repeat(30)}`).join("\n");
    const result = normalize(postToolUse("Write", {
      file_path: "/project/src/big.ts",
      content: lines,
    }, { success: true }));
    expect(result.content_summary.length).toBeLessThanOrEqual(2000);
    expect(result.content_summary).not.toMatch(/[^\n]$/); // doesn't end mid-line (ends with \n or is exact)
    const lastNewline = result.content_summary.lastIndexOf("\n");
    const afterLast = result.content_summary.slice(lastNewline + 1);
    // After the last newline, either nothing or a complete line
    expect(afterLast === "" || !afterLast.includes("\n")).toBe(true);
  });

  // --- raw_event ---

  test("raw_event contains serialized payload without _batch", () => {
    const payload = postToolUse("Edit", { file_path: "/project/a.ts", old_string: "a", new_string: "b" }, { success: true });
    (payload as any)._batch = { batch_size: 2, batch_index: 0, multi_file_edit: true, unique_files: ["a.ts", "b.ts"] };
    const result = normalize(payload);
    const parsed = JSON.parse(result.raw_event);
    expect(parsed._batch).toBeUndefined();
    expect(parsed.tool).toBe("Edit");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/pipelines/ingest/normalize.test.ts`
Expected: FAIL — `normalize` not found

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/pipelines/ingest/normalize.test.ts
git commit -m "test: add failing tests for ingest normalizer (15 cases)"
```

---

### Task 5: Implement normalize.ts

**Files:**
- Create: `src/pipelines/ingest/normalize.ts`

- [ ] **Step 1: Implement normalize**

```typescript
import type { HookPayload, NormalizedEvent } from "../../types";

const MAX_CONTENT = 2000;
const MAX_EDIT_HALF = 900;

function truncateAtLine(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf("\n", maxLen);
  return cut > 0 ? text.slice(0, cut + 1) : text.slice(0, maxLen);
}

function stripBatch(payload: HookPayload): string {
  const copy = { ...payload } as Record<string, unknown>;
  delete copy._batch;
  return JSON.stringify(copy);
}

export function normalize(payload: HookPayload): NormalizedEvent {
  const tool = (payload as any).tool as string | undefined;
  const inp = (payload as any).input as Record<string, unknown> | undefined;
  const out = (payload as any).output as Record<string, unknown> | undefined;

  if (payload.type === "SessionStart") {
    return {
      tool: null,
      files: [],
      action: "session_start",
      content_summary: `SESSION_START project=${payload.cwd} trigger=${(payload as any).trigger ?? "unknown"}`,
      raw_event: stripBatch(payload),
    };
  }

  if (payload.type === "Stop") {
    return {
      tool: null,
      files: [],
      action: "session_end",
      content_summary: `SESSION_END project=${payload.cwd}`,
      raw_event: stripBatch(payload),
    };
  }

  if (payload.type === "UserPromptSubmit") {
    const prompt = ((payload as any).prompt ?? "") as string;
    return {
      tool: null,
      files: [],
      action: "prompt",
      content_summary: truncateAtLine(`PROMPT ${prompt}`, MAX_CONTENT),
      raw_event: stripBatch(payload),
    };
  }

  // PostToolUse
  const filePath = (inp?.file_path ?? "") as string;
  const files = filePath ? [filePath] : [];

  if (tool === "Edit") {
    const oldStr = truncateAtLine((inp?.old_string ?? "") as string, MAX_EDIT_HALF);
    const newStr = truncateAtLine((inp?.new_string ?? "") as string, MAX_EDIT_HALF);
    return {
      tool: "Edit",
      files,
      action: "edit",
      content_summary: truncateAtLine(`EDIT ${filePath}\n--- old\n${oldStr}\n+++ new\n${newStr}`, MAX_CONTENT),
      raw_event: stripBatch(payload),
    };
  }

  if (tool === "Write") {
    const content = (inp?.content ?? "") as string;
    return {
      tool: "Write",
      files,
      action: "write",
      content_summary: truncateAtLine(`WRITE ${filePath}\n${content}`, MAX_CONTENT),
      raw_event: stripBatch(payload),
    };
  }

  if (tool === "Read") {
    const content = (out?.content ?? "") as string;
    return {
      tool: "Read",
      files,
      action: "read",
      content_summary: truncateAtLine(`READ ${filePath}\n${content}`, MAX_CONTENT),
      raw_event: stripBatch(payload),
    };
  }

  if (tool === "Bash") {
    const command = (inp?.command ?? "") as string;
    const stdout = (out?.stdout ?? "") as string;
    const stderr = (out?.stderr ?? "") as string;
    const header = `BASH $ ${command}\n`;
    const budget = MAX_CONTENT - header.length;
    const stderrBudget = Math.min(stderr.length, Math.floor(budget * 0.25));
    const stdoutBudget = Math.min(stdout.length, budget - stderrBudget);
    const truncStdout = truncateAtLine(stdout, stdoutBudget);
    const truncStderr = truncateAtLine(stderr, stderrBudget);
    let summary = header + truncStdout;
    if (truncStderr) summary += "\n" + truncStderr;
    return {
      tool: "Bash",
      files: [],
      action: "bash",
      content_summary: summary.slice(0, MAX_CONTENT),
      raw_event: stripBatch(payload),
    };
  }

  // Unknown tool — best effort
  return {
    tool: tool ?? null,
    files,
    action: tool?.toLowerCase() ?? "unknown",
    content_summary: truncateAtLine(JSON.stringify(inp ?? {}), MAX_CONTENT),
    raw_event: stripBatch(payload),
  };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test tests/pipelines/ingest/normalize.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/pipelines/ingest/normalize.ts
git commit -m "feat: implement event normalizer with per-tool content formatting"
```

---

## Chunk 3: Debouncer

### Task 6: Write failing tests for debounce.ts

**Files:**
- Create: `tests/pipelines/ingest/debounce.test.ts`

- [ ] **Step 1: Write debouncer tests**

The debouncer buffers events per session. When the first event arrives for a session, a timer starts (default 100ms). All events for that session received before the timer fires are emitted as a batch. The window is fixed — new events don't extend it.

```typescript
import { describe, test, expect } from "bun:test";
import { Debouncer } from "../../../src/pipelines/ingest/debounce";
import type { HookPayload, BatchAnnotation } from "../../../src/types";

function makePayload(sessionId: string, tool: string = "Edit", filePath: string = "/project/a.ts"): HookPayload {
  return {
    type: "PostToolUse",
    session_id: sessionId,
    cwd: "/project",
    tool,
    input: { file_path: filePath, old_string: "a", new_string: "b" },
    output: { success: true },
  };
}

describe("Debouncer", () => {
  test("single event emits after debounce window", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1"));
    expect(emitted.length).toBe(0);

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(1);
    expect(emitted[0].batch.batch_size).toBe(1);
    expect(emitted[0].batch.batch_index).toBe(0);
    expect(emitted[0].batch.multi_file_edit).toBe(false);

    debouncer.destroy();
  });

  test("multiple events in same window emit as batch", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1", "Edit", "/project/a.ts"));
    debouncer.push(makePayload("s1", "Edit", "/project/b.ts"));
    debouncer.push(makePayload("s1", "Edit", "/project/a.ts")); // duplicate file

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(3);
    expect(emitted[0].batch.batch_size).toBe(3);
    expect(emitted[0].batch.multi_file_edit).toBe(true);
    expect(emitted[0].batch.unique_files).toEqual(["/project/a.ts", "/project/b.ts"]);
    expect(emitted[1].batch.batch_index).toBe(1);
    expect(emitted[2].batch.batch_index).toBe(2);

    debouncer.destroy();
  });

  test("different sessions are debounced independently", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1"));
    debouncer.push(makePayload("s2"));

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(2);
    // Each session gets its own batch of size 1
    expect(emitted[0].batch.batch_size).toBe(1);
    expect(emitted[1].batch.batch_size).toBe(1);

    debouncer.destroy();
  });

  test("window is fixed — new events do not extend the timer", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1", "Edit", "/project/a.ts"));
    await new Promise((r) => setTimeout(r, 30));
    debouncer.push(makePayload("s1", "Edit", "/project/b.ts"));
    // 30ms in, second event arrives. Timer started at t=0, fires at t=50.
    // Both events should be emitted at ~t=50, not t=80.

    await new Promise((r) => setTimeout(r, 40)); // now at ~t=70
    expect(emitted.length).toBe(2);

    debouncer.destroy();
  });

  test("multi_file_edit is false for single-file batch", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1", "Edit", "/project/a.ts"));
    debouncer.push(makePayload("s1", "Edit", "/project/a.ts"));

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted[0].batch.multi_file_edit).toBe(false);
    expect(emitted[0].batch.unique_files).toEqual(["/project/a.ts"]);

    debouncer.destroy();
  });

  test("non-Edit/Write events do not contribute to unique_files", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1", "Edit", "/project/a.ts"));
    debouncer.push({
      type: "PostToolUse", session_id: "s1", cwd: "/project",
      tool: "Bash", input: { command: "ls" }, output: { stdout: "", stderr: "", exit_code: 0 },
    });

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(2);
    expect(emitted[0].batch.unique_files).toEqual(["/project/a.ts"]);
    expect(emitted[0].batch.multi_file_edit).toBe(false);

    debouncer.destroy();
  });

  test("flush() emits pending events immediately", () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(5000, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1"));
    debouncer.push(makePayload("s2"));
    expect(emitted.length).toBe(0);

    debouncer.flush();
    expect(emitted.length).toBe(2);

    debouncer.destroy();
  });

  test("destroy() clears all timers and pending events", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1"));
    debouncer.destroy();

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/pipelines/ingest/debounce.test.ts`
Expected: FAIL — `Debouncer` not found

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/pipelines/ingest/debounce.test.ts
git commit -m "test: add failing tests for event debouncer (8 cases)"
```

---

### Task 7: Implement debounce.ts

**Files:**
- Create: `src/pipelines/ingest/debounce.ts`

- [ ] **Step 1: Implement Debouncer**

```typescript
import type { HookPayload, BatchAnnotation } from "../../types";

type EmitFn = (payload: HookPayload, batch: BatchAnnotation) => void;

interface SessionBuffer {
  events: HookPayload[];
  timer: ReturnType<typeof setTimeout>;
  uniqueFiles: Set<string>;
}

export class Debouncer {
  private buffers = new Map<string, SessionBuffer>();
  private emit: EmitFn;
  private windowMs: number;

  constructor(windowMs: number, emit: EmitFn) {
    this.windowMs = windowMs;
    this.emit = emit;
  }

  push(payload: HookPayload): void {
    const sid = payload.session_id;
    let buf = this.buffers.get(sid);

    if (!buf) {
      buf = {
        events: [],
        timer: setTimeout(() => this.flushSession(sid), this.windowMs),
        uniqueFiles: new Set(),
      };
      this.buffers.set(sid, buf);
    }

    buf.events.push(payload);

    const tool = (payload as any).tool as string | undefined;
    if (tool === "Edit" || tool === "Write") {
      const filePath = ((payload as any).input?.file_path ?? "") as string;
      if (filePath) buf.uniqueFiles.add(filePath);
    }
  }

  flush(): void {
    for (const sid of [...this.buffers.keys()]) {
      this.flushSession(sid);
    }
  }

  destroy(): void {
    for (const buf of this.buffers.values()) {
      clearTimeout(buf.timer);
    }
    this.buffers.clear();
  }

  private flushSession(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (!buf) return;

    clearTimeout(buf.timer);
    this.buffers.delete(sessionId);

    const uniqueFiles = [...buf.uniqueFiles];
    const multiFileEdit = uniqueFiles.length >= 2;
    const batchSize = buf.events.length;

    for (let i = 0; i < batchSize; i++) {
      const batch: BatchAnnotation = {
        batch_size: batchSize,
        batch_index: i,
        multi_file_edit: multiFileEdit,
        unique_files: uniqueFiles,
      };
      this.emit(buf.events[i], batch);
    }
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test tests/pipelines/ingest/debounce.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/pipelines/ingest/debounce.ts
git commit -m "feat: implement per-session event debouncer with fixed window"
```

---

### Task 8: Run full test suite and verify

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: ALL PASS — kernel tests + classify + normalize + debounce

- [ ] **Step 2: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Final commit if needed**

```bash
git add -A
git status
# Only commit if there are changes
git commit -m "chore: fix any remaining type errors or test issues"
```
