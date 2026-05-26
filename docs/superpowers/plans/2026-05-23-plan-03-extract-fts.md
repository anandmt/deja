# Plan 3: Heuristic Extract + FTS Store/Search

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the heuristic extractor (Tier 0) that transforms normalized events into structured observations, plus the FTS store and search functions. After this plan, the full ingest pipeline (classify → normalize → extract → store) is complete and searchable.

**Architecture:** The heuristic extractor is a pure function: `NormalizedEvent + ClassifyResult → ExtractedObservation`. It uses regex-based symbol detection and file-path analysis — no AST parsing, no LLM calls, zero external dependencies. The FTS store is a thin INSERT wrapper; FTS5 triggers handle index sync automatically. The FTS search uses BM25 ranking with optional filters.

**Tech Stack:** Bun >= 1.3.6, TypeScript (strict), bun:test, bun:sqlite

**Spec:** `docs/superpowers/specs/2026-05-22-deja-design.md` (lines 660-700)

**Plan series:**
1. ~~Kernel~~ (done) — db, migrations, settings, lock, logging, shared types
2. ~~Ingest Pipeline~~ (done) — classify, normalize, debounce
3. **Heuristic Extract + FTS Store/Search** (this plan)
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
├── pipelines/
│   ├── extract/
│   │   └── heuristic.ts       # extractHeuristic + concept/symbol utilities
│   ├── index/
│   │   └── fts.ts             # storeObservation (INSERT + let FTS triggers fire)
│   └── search/
│       └── fts.ts             # searchFts (FTS5 MATCH + BM25 ranking)
tests/
├── pipelines/
│   ├── extract/
│   │   └── heuristic.test.ts
│   ├── index/
│   │   └── fts.test.ts
│   └── search/
│       └── fts.test.ts
```

---

## Chunk 1: Heuristic Extractor

### Task 1: Tests for concept normalization, path extraction, symbol extraction

**Files:**
- Create: `tests/pipelines/extract/heuristic.test.ts`

- [ ] **Step 1: Write tests for exported utility functions**

```typescript
import { describe, test, expect } from "bun:test";
import {
  normalizeConcept,
  extractConceptsFromPath,
  extractSymbols,
  capConcepts,
  extractHeuristic,
} from "../../../src/pipelines/extract/heuristic";
import type { NormalizedEvent, ClassifyResult } from "../../../src/types";

describe("normalizeConcept", () => {
  test("splits camelCase", () => {
    expect(normalizeConcept("connectionManager")).toBe("connection-manager");
  });

  test("splits PascalCase", () => {
    expect(normalizeConcept("ConnectionManager")).toBe("connection-manager");
  });

  test("splits consecutive uppercase (XMLParser)", () => {
    expect(normalizeConcept("XMLParser")).toBe("xml-parser");
  });

  test("collapses underscores to hyphens", () => {
    expect(normalizeConcept("Rate_Limiting")).toBe("rate-limiting");
  });

  test("already normalized passthrough", () => {
    expect(normalizeConcept("rate-limiting")).toBe("rate-limiting");
  });

  test("trims leading/trailing hyphens from dunder", () => {
    expect(normalizeConcept("__init__")).toBe("init");
  });
});

describe("extractConceptsFromPath", () => {
  test("extracts non-stopword segments", () => {
    expect(extractConceptsFromPath("src/tools/trading.py")).toEqual(["tools", "trading"]);
  });

  test("drops all stopwords and extensions", () => {
    expect(extractConceptsFromPath("src/index.ts")).toEqual([]);
  });

  test("extracts multiple meaningful segments", () => {
    expect(extractConceptsFromPath("src/services/auth/oauth-handler.ts")).toEqual([
      "services", "auth", "oauth-handler",
    ]);
  });

  test("normalizes segments with camelCase", () => {
    expect(extractConceptsFromPath("src/userAuth/sessionManager.ts")).toEqual([
      "user-auth", "session-manager",
    ]);
  });

  test("handles root-level files", () => {
    expect(extractConceptsFromPath("Dockerfile")).toEqual(["dockerfile"]);
  });
});

describe("extractSymbols", () => {
  test("detects JS/TS function declarations", () => {
    expect(extractSymbols("function handleAuth() {")).toContain("handleAuth");
  });

  test("detects async functions", () => {
    expect(extractSymbols("async function fetchData() {")).toContain("fetchData");
  });

  test("detects class declarations", () => {
    expect(extractSymbols("class ConnectionManager {")).toContain("ConnectionManager");
  });

  test("detects Python def", () => {
    expect(extractSymbols("def reconnect(self):")).toContain("reconnect");
  });

  test("detects Go func", () => {
    expect(extractSymbols("func HandleRequest(w http.ResponseWriter) {")).toContain("HandleRequest");
  });

  test("detects Rust fn", () => {
    expect(extractSymbols("pub fn process_event(ev: &Event) -> Result<()> {")).toContain("process_event");
  });

  test("detects export const", () => {
    expect(extractSymbols("export const API_TIMEOUT = 5000;")).toContain("API_TIMEOUT");
  });

  test("returns multiple symbols", () => {
    const text = "class Foo {\n  function bar() {}\n}";
    const symbols = extractSymbols(text);
    expect(symbols).toContain("Foo");
    expect(symbols).toContain("bar");
  });

  test("returns empty for no matches", () => {
    expect(extractSymbols("just some text")).toEqual([]);
  });
});

describe("capConcepts", () => {
  test("keeps all when under limit", () => {
    expect(capConcepts(["a", "bb", "ccc"], 5)).toEqual(["a", "bb", "ccc"]);
  });

  test("caps at max, keeping longest", () => {
    const input = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff", "ggggggg"];
    const result = capConcepts(input, 5);
    expect(result.length).toBe(5);
    expect(result).toContain("ggggggg");
    expect(result).toContain("ffffff");
    expect(result).not.toContain("a");
  });

  test("deduplicates", () => {
    expect(capConcepts(["auth", "auth", "config"], 5)).toEqual(["auth", "config"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/pipelines/extract/heuristic.test.ts`
Expected: FAIL — imports not found

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/pipelines/extract/heuristic.test.ts
git commit -m "test: add failing tests for concept/symbol extraction utilities"
```

---

### Task 2: Implement concept and symbol utilities

**Files:**
- Create: `src/pipelines/extract/heuristic.ts`

- [ ] **Step 1: Implement utility functions (extractHeuristic will be added in Task 4)**

```typescript
import type { NormalizedEvent, ClassifyResult, ExtractedObservation } from "../../types";

const PATH_STOPWORDS = new Set([
  "src", "lib", "app", "dist", "build", "index", "main",
  "test", "tests", "spec", "__pycache__", "node_modules",
]);

const FILE_EXTENSIONS = new Set([
  "py", "ts", "tsx", "js", "jsx", "go", "rs", "java",
  "rb", "c", "cpp", "h", "hpp", "cs", "swift", "kt",
  "vue", "svelte", "astro", "md", "json", "yaml", "yml",
  "toml", "cfg", "ini", "sh", "bash", "zsh",
]);

export function normalizeConcept(raw: string): string {
  return raw
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function extractConceptsFromPath(filePath: string): string[] {
  const segments = filePath.split(/[/\\.]/).filter((s) => s.length > 0);
  return segments
    .filter((s) => !PATH_STOPWORDS.has(s) && !FILE_EXTENSIONS.has(s))
    .map(normalizeConcept)
    .filter((s) => s.length > 0);
}

const SYMBOL_PATTERNS = [
  /(?:^|\n)\s*def\s+(\w+)/g,
  /(?:^|\n)\s*(?:async\s+)?function\s+(\w+)/g,
  /(?:^|\n)\s*class\s+(\w+)/g,
  /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+(\w+)/g,
  /(?:^|\n)\s*func\s+(\w+)/g,
  /(?:^|\n)\s*(?:pub\s+)?fn\s+(\w+)/g,
];

export function extractSymbols(text: string): string[] {
  const symbols: string[] = [];
  for (const pattern of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      symbols.push(match[1]);
    }
  }
  return [...new Set(symbols)];
}

export function capConcepts(concepts: string[], max: number = 5): string[] {
  const unique = [...new Set(concepts)];
  if (unique.length <= max) return unique;
  return unique.sort((a, b) => b.length - a.length).slice(0, max);
}

// Placeholder — implemented in Task 4
export function extractHeuristic(
  _normalized: NormalizedEvent,
  _classify: ClassifyResult,
): ExtractedObservation {
  throw new Error("Not implemented yet");
}
```

- [ ] **Step 2: Run utility tests (extractHeuristic tests will still fail)**

Run: `bun test tests/pipelines/extract/heuristic.test.ts --test-name-pattern "normalizeConcept|extractConceptsFromPath|extractSymbols|capConcepts"`
Expected: ALL PASS for utility tests

- [ ] **Step 3: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pipelines/extract/heuristic.ts
git commit -m "feat: implement concept normalization, path extraction, and symbol detection"
```

---

### Task 3: Tests for extractHeuristic

**Files:**
- Modify: `tests/pipelines/extract/heuristic.test.ts` (append to existing file)

- [ ] **Step 1: Add extractHeuristic tests after the utility tests**

Append to the test file:

```typescript
function makeNormalized(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    tool: null,
    files: [],
    action: "unknown",
    content_summary: "",
    raw_event: "{}",
    ...overrides,
  };
}

function makeClassify(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return { significance: "medium", rule: "default", ...overrides };
}

describe("extractHeuristic", () => {
  describe("Edit events", () => {
    test("extracts function name into title", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Edit",
          files: ["/project/src/connection.ts"],
          action: "edit",
          content_summary: "EDIT /project/src/connection.ts\n--- old\nfunction reconnect() { return false; }\n+++ new\nfunction reconnect() { return true; }",
        }),
        makeClassify(),
      );
      expect(result.kind).toBe("file_edit");
      expect(result.title).toContain("reconnect");
      expect(result.title).toContain("connection.ts");
      expect(result.files_modified).toEqual(["/project/src/connection.ts"]);
      expect(result.files_read).toEqual([]);
    });

    test("falls back to generic title without symbols", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Edit",
          files: ["/project/src/config.ts"],
          action: "edit",
          content_summary: "EDIT /project/src/config.ts\n--- old\ntimeout = 5000\n+++ new\ntimeout = 10000",
        }),
        makeClassify(),
      );
      expect(result.title).toBe("Edited config.ts");
    });

    test("extracts concepts from file path", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Edit",
          files: ["/project/src/services/auth/handler.ts"],
          action: "edit",
          content_summary: "EDIT /project/src/services/auth/handler.ts\n--- old\nx\n+++ new\ny",
        }),
        makeClassify(),
      );
      expect(result.concepts).toContain("services");
      expect(result.concepts).toContain("auth");
      expect(result.concepts).toContain("handler");
    });

    test("adds detected symbols as concepts", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Edit",
          files: ["/project/src/app.ts"],
          action: "edit",
          content_summary: "EDIT /project/src/app.ts\n--- old\n\n+++ new\nclass ConnectionManager {",
        }),
        makeClassify(),
      );
      expect(result.concepts).toContain("connection-manager");
    });
  });

  describe("Write events", () => {
    test("creates file_write observation with Created title", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Write",
          files: ["/project/src/new-module.ts"],
          action: "write",
          content_summary: "WRITE /project/src/new-module.ts\nexport class Foo {\n  bar() {}\n}",
        }),
        makeClassify({ significance: "critical", rule: "new_source_file" }),
      );
      expect(result.kind).toBe("file_write");
      expect(result.title).toBe("Created new-module.ts");
      expect(result.files_modified).toEqual(["/project/src/new-module.ts"]);
    });

    test("extracts symbols from written content", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Write",
          files: ["/project/src/handler.ts"],
          action: "write",
          content_summary: "WRITE /project/src/handler.ts\nexport function handleAuth() {}\nexport class AuthProvider {}",
        }),
        makeClassify(),
      );
      expect(result.facts).toContain("handleAuth");
      expect(result.facts).toContain("AuthProvider");
    });
  });

  describe("Read events", () => {
    test("creates file_read observation", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Read",
          files: ["/project/src/client.py"],
          action: "read",
          content_summary: "READ /project/src/client.py\nimport asyncio\n\nclass IBKRClient:\n    pass",
        }),
        makeClassify({ significance: "low", rule: "config_file_read" }),
      );
      expect(result.kind).toBe("file_read");
      expect(result.title).toBe("Read client.py");
      expect(result.files_read).toEqual(["/project/src/client.py"]);
      expect(result.files_modified).toEqual([]);
    });
  });

  describe("Bash events", () => {
    test("detects test runner with pass/fail counts", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Bash",
          action: "bash",
          content_summary: "BASH $ pytest tests/ -v\n42 passed, 3 failed",
        }),
        makeClassify({ significance: "high", rule: "test_failure" }),
      );
      expect(result.kind).toBe("bash_cmd");
      expect(result.title).toContain("42 passed");
      expect(result.title).toContain("3 failed");
      expect(result.title).toContain("pytest");
      expect(result.concepts).toContain("testing");
    });

    test("detects test runner success", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Bash",
          action: "bash",
          content_summary: "BASH $ bun test\n10 pass\n0 fail",
        }),
        makeClassify(),
      );
      expect(result.title).toContain("10 passed");
      expect(result.title).toContain("bun:test");
    });

    test("detects git commit", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Bash",
          action: "bash",
          content_summary: "BASH $ git commit -m \"feat: add auth\"\n[main abc1234] feat: add auth",
        }),
        makeClassify(),
      );
      expect(result.title).toContain("Git:");
      expect(result.title).toContain("feat: add auth");
      expect(result.concepts).toContain("git");
      expect(result.concepts).toContain("git-commit");
    });

    test("detects git checkout/switch", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Bash",
          action: "bash",
          content_summary: "BASH $ git checkout feature-branch\nSwitched to branch 'feature-branch'",
        }),
        makeClassify(),
      );
      expect(result.title).toContain("Git:");
      expect(result.title).toContain("feature-branch");
    });

    test("generic bash command title", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Bash",
          action: "bash",
          content_summary: "BASH $ npm run build\nCompiled successfully",
        }),
        makeClassify(),
      );
      expect(result.title).toBe("Ran: npm run build");
    });

    test("bash error includes exit indication", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Bash",
          action: "bash",
          content_summary: "BASH $ node server.js\nError: EADDRINUSE",
        }),
        makeClassify({ significance: "high", rule: "error_debugging" }),
      );
      expect(result.kind).toBe("bash_cmd");
      expect(result.title).toContain("Error:");
    });
  });

  describe("Prompt events", () => {
    test("CRITICAL decision → kind=decision, Decision title", () => {
      const result = extractHeuristic(
        makeNormalized({
          action: "prompt",
          content_summary: "PROMPT let's use Redis for caching instead of Memcached, it has better pub/sub support",
        }),
        makeClassify({ significance: "critical", rule: "decision_prompt" }),
      );
      expect(result.kind).toBe("decision");
      expect(result.title).toMatch(/^Decision: /);
      expect(result.title).toContain("Redis");
      expect(result.title.length).toBeLessThanOrEqual(90); // "Decision: " (10) + 80
    });

    test("non-decision prompt → kind=prompt, Prompt title", () => {
      const result = extractHeuristic(
        makeNormalized({
          action: "prompt",
          content_summary: "PROMPT fix the rate limiting bug in client.py",
        }),
        makeClassify(),
      );
      expect(result.kind).toBe("prompt");
      expect(result.title).toMatch(/^Prompt: /);
      expect(result.title).toContain("rate limiting");
    });
  });

  describe("empty files edge case", () => {
    test("edit with no file uses 'unknown' in title", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Edit",
          files: [],
          action: "edit",
          content_summary: "EDIT \n--- old\nfoo\n+++ new\nbar",
        }),
        makeClassify(),
      );
      expect(result.title).toBe("Edited unknown");
    });
  });

  describe("concept cap", () => {
    test("caps concepts at 5", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Edit",
          files: ["/project/src/services/auth/oauth/token/refresh/handler.ts"],
          action: "edit",
          content_summary: "EDIT /project/src/services/auth/oauth/token/refresh/handler.ts\n--- old\nclass TokenRefreshHandler {}\n+++ new\nclass TokenRefreshHandler { refresh() {} }",
        }),
        makeClassify(),
      );
      expect(result.concepts.length).toBeLessThanOrEqual(5);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/pipelines/extract/heuristic.test.ts`
Expected: Utility tests PASS, extractHeuristic tests FAIL (throws "Not implemented yet")

- [ ] **Step 3: Commit**

```bash
git add tests/pipelines/extract/heuristic.test.ts
git commit -m "test: add failing tests for heuristic extractor (18 cases)"
```

---

### Task 4: Implement extractHeuristic

**Files:**
- Modify: `src/pipelines/extract/heuristic.ts` (replace placeholder)

- [ ] **Step 1: Replace the placeholder extractHeuristic with full implementation**

Replace the placeholder function with:

```typescript
function basename(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? filePath : filePath.slice(i + 1);
}

function parseBashCommand(contentSummary: string): { command: string; output: string } {
  const firstNewline = contentSummary.indexOf("\n");
  if (firstNewline === -1) return { command: contentSummary.slice(7), output: "" };
  return {
    command: contentSummary.slice(7, firstNewline),
    output: contentSummary.slice(firstNewline + 1),
  };
}

const TEST_RUNNERS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /pytest/, name: "pytest" },
  { pattern: /jest/, name: "jest" },
  { pattern: /vitest/, name: "vitest" },
  { pattern: /bun test/, name: "bun:test" },
  { pattern: /cargo test/, name: "cargo" },
  { pattern: /go test/, name: "go" },
  { pattern: /npm test/, name: "npm" },
];

function extractBashConcepts(command: string): string[] {
  const concepts: string[] = [];
  if (TEST_RUNNERS.some((r) => r.pattern.test(command))) {
    concepts.push("testing");
  }
  const gitMatch = command.match(/^git\s+(\w+)/);
  if (gitMatch) {
    concepts.push("git", `git-${gitMatch[1]}`);
  }
  if (/npm run build|cargo build|make\b|webpack|vite build/.test(command)) {
    concepts.push("build");
  }
  return concepts;
}

function extractBashTitle(command: string, output: string, isFailed: boolean): string {
  for (const runner of TEST_RUNNERS) {
    if (runner.pattern.test(command)) {
      const passMatch = output.match(/(\d+)\s*pass/i);
      const failMatch = output.match(/(\d+)\s*fail/i);
      const parts: string[] = [];
      if (passMatch) parts.push(`${passMatch[1]} passed`);
      if (failMatch) parts.push(`${failMatch[1]} failed`);
      if (parts.length > 0) return `Tests: ${parts.join(", ")} (${runner.name})`;
      return isFailed ? `Tests: failed (${runner.name})` : `Tests: passed (${runner.name})`;
    }
  }

  const gitMatch = command.match(/^git\s+(\w+)/);
  if (gitMatch) {
    const sub = gitMatch[1];
    if (sub === "commit") {
      const msgMatch = command.match(/-m\s+["']([^"']+)["']/);
      return msgMatch ? `Git: commit "${msgMatch[1].slice(0, 60)}"` : "Git: commit";
    }
    if (sub === "checkout" || sub === "switch") {
      const branchMatch = command.match(/(?:checkout|switch)\s+(?:-[bB]\s+)?(\S+)/);
      return branchMatch ? `Git: ${sub} ${branchMatch[1]}` : `Git: ${sub}`;
    }
    return `Git: ${sub}`;
  }

  if (isFailed) return `Error: ${command.slice(0, 70)}`;
  return `Ran: ${command.slice(0, 80)}`;
}

export function extractHeuristic(
  normalized: NormalizedEvent,
  classify: ClassifyResult,
): ExtractedObservation {
  const file = normalized.files[0] ?? "";
  const name = file ? basename(file) : "";
  const content = normalized.content_summary;

  // --- Edit ---
  if (normalized.action === "edit") {
    const symbols = extractSymbols(content);
    const pathConcepts = file ? extractConceptsFromPath(file) : [];
    const symbolConcepts = symbols.map(normalizeConcept);
    const label = name || "unknown";
    const title = symbols.length > 0
      ? `Modified ${symbols[0]}() in ${label}`
      : `Edited ${label}`;
    return {
      kind: "file_edit",
      title,
      content,
      facts: symbols,
      concepts: capConcepts([...pathConcepts, ...symbolConcepts]),
      files_read: [],
      files_modified: normalized.files,
    };
  }

  // --- Write ---
  if (normalized.action === "write") {
    const symbols = extractSymbols(content);
    const pathConcepts = file ? extractConceptsFromPath(file) : [];
    const symbolConcepts = symbols.map(normalizeConcept);
    return {
      kind: "file_write",
      title: `Created ${name || "unknown"}`,
      content,
      facts: symbols,
      concepts: capConcepts([...pathConcepts, ...symbolConcepts]),
      files_read: [],
      files_modified: normalized.files,
    };
  }

  // --- Read ---
  if (normalized.action === "read") {
    const pathConcepts = file ? extractConceptsFromPath(file) : [];
    return {
      kind: "file_read",
      title: `Read ${name || "unknown"}`,
      content,
      facts: [],
      concepts: capConcepts(pathConcepts),
      files_read: normalized.files,
      files_modified: [],
    };
  }

  // --- Bash ---
  if (normalized.action === "bash") {
    const { command, output } = parseBashCommand(content);
    const isFailed = classify.rule === "test_failure" || classify.rule === "error_debugging";
    const title = extractBashTitle(command, output, isFailed);
    const concepts = extractBashConcepts(command);
    if (isFailed && TEST_RUNNERS.some((r) => r.pattern.test(command))) {
      concepts.push("failure");
    }
    return {
      kind: "bash_cmd",
      title,
      content,
      facts: [],
      concepts: capConcepts(concepts),
      files_read: [],
      files_modified: [],
    };
  }

  // --- Prompt ---
  if (normalized.action === "prompt") {
    const promptText = content.startsWith("PROMPT ") ? content.slice(7) : content;
    const isDecision = classify.significance === "critical" && classify.rule === "decision_prompt";
    const prefix = isDecision ? "Decision" : "Prompt";
    return {
      kind: isDecision ? "decision" : "prompt",
      title: `${prefix}: ${promptText.slice(0, 80)}`,
      content,
      facts: [],
      concepts: [],
      files_read: [],
      files_modified: [],
    };
  }

  // --- Fallback ---
  return {
    kind: "prompt",
    title: `Event: ${normalized.action}`,
    content,
    facts: [],
    concepts: [],
    files_read: [],
    files_modified: [],
  };
}
```

- [ ] **Step 2: Run tests to verify they all pass**

Run: `bun test tests/pipelines/extract/heuristic.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pipelines/extract/heuristic.ts
git commit -m "feat: implement heuristic extractor for all event types"
```

---

## Chunk 2: FTS Store + Search

### Task 5: Tests and implementation for storeObservation

**Files:**
- Create: `tests/pipelines/index/fts.test.ts`
- Create: `src/pipelines/index/fts.ts`

- [ ] **Step 1: Write store tests**

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../../src/test/helpers";
import { runMigrations } from "../../../src/kernel/migrations";
import { storeObservation } from "../../../src/pipelines/index/fts";
import type { ExtractedObservation } from "../../../src/types";

function makeObs(overrides: Partial<ExtractedObservation> = {}): ExtractedObservation {
  return {
    kind: "file_edit",
    title: "Edited app.ts",
    content: "EDIT /project/src/app.ts\n--- old\nx\n+++ new\ny",
    facts: ["handleAuth"],
    concepts: ["auth", "handler"],
    files_read: [],
    files_modified: ["/project/src/app.ts"],
    ...overrides,
  };
}

describe("storeObservation", () => {
  let db: Database;

  afterEach(() => {
    if (db) cleanupDb(db);
  });

  test("inserts and returns id", () => {
    db = tmpDb();
    runMigrations(db);
    db.exec("INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/project', 1000)");
    const id = storeObservation(db, "s1", "/project", "medium", makeObs(), "{}", 1000);
    expect(id).toBe(1);
  });

  test("stored observation is retrievable", () => {
    db = tmpDb();
    runMigrations(db);
    db.exec("INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/project', 1000)");
    storeObservation(db, "s1", "/project", "high", makeObs({ title: "Created foo.ts" }), "{}", 2000);
    const row = db.query("SELECT title, significance, kind FROM observations WHERE id = 1").get() as any;
    expect(row.title).toBe("Created foo.ts");
    expect(row.significance).toBe("high");
    expect(row.kind).toBe("file_edit");
  });

  test("serializes JSON arrays for facts and concepts", () => {
    db = tmpDb();
    runMigrations(db);
    db.exec("INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/project', 1000)");
    storeObservation(db, "s1", "/project", "medium", makeObs({ facts: ["a", "b"], concepts: ["c"] }), "{}", 1000);
    const row = db.query("SELECT facts, concepts FROM observations WHERE id = 1").get() as any;
    expect(JSON.parse(row.facts)).toEqual(["a", "b"]);
    expect(JSON.parse(row.concepts)).toEqual(["c"]);
  });

  test("FTS trigger fires — observation is searchable", () => {
    db = tmpDb();
    runMigrations(db);
    db.exec("INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/project', 1000)");
    storeObservation(db, "s1", "/project", "medium", makeObs({ title: "Modified handleAuth()" }), "{}", 1000);
    const fts = db.query("SELECT * FROM observations_fts WHERE observations_fts MATCH 'handleAuth'").all();
    expect(fts.length).toBe(1);
  });

  test("multiple observations get sequential ids", () => {
    db = tmpDb();
    runMigrations(db);
    db.exec("INSERT INTO sessions (id, project, started_at_epoch) VALUES ('s1', '/project', 1000)");
    const id1 = storeObservation(db, "s1", "/project", "medium", makeObs(), "{}", 1000);
    const id2 = storeObservation(db, "s1", "/project", "high", makeObs({ title: "Second" }), "{}", 2000);
    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });
});
```

- [ ] **Step 2: Write the implementation**

```typescript
import type { Database } from "bun:sqlite";
import type { ExtractedObservation, Significance } from "../../types";

export function storeObservation(
  db: Database,
  sessionId: string,
  project: string,
  significance: Significance,
  obs: ExtractedObservation,
  rawEvent: string,
  createdAtEpoch: number,
): number {
  const stmt = db.prepare(`
    INSERT INTO observations (session_id, project, significance, kind, title, content,
      facts, concepts, files_read, files_modified, raw_event, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    sessionId,
    project,
    significance,
    obs.kind,
    obs.title,
    obs.content,
    JSON.stringify(obs.facts),
    JSON.stringify(obs.concepts),
    JSON.stringify(obs.files_read),
    JSON.stringify(obs.files_modified),
    rawEvent,
    createdAtEpoch,
  );
  return Number(result.lastInsertRowid);
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/pipelines/index/fts.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/pipelines/index/fts.test.ts src/pipelines/index/fts.ts
git commit -m "feat: implement observation store with FTS trigger verification"
```

---

### Task 6: Tests and implementation for searchFts

**Files:**
- Create: `tests/pipelines/search/fts.test.ts`
- Create: `src/pipelines/search/fts.ts`

- [ ] **Step 1: Write search tests**

```typescript
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
```

- [ ] **Step 2: Write the implementation**

```typescript
import type { Database } from "bun:sqlite";
import type { Significance } from "../../types";

export interface SearchResult {
  id: number;
  title: string;
  significance: string;
  kind: string;
  created_at_epoch: number;
}

export interface SearchOptions {
  project?: string;
  significance?: Significance;
  kind?: string;
  limit?: number;
}

export function searchFts(
  db: Database,
  query: string,
  options: SearchOptions = {},
): { results: SearchResult[]; total_count: number } {
  if (!query.trim()) return { results: [], total_count: 0 };

  const limit = Math.min(options.limit ?? 20, 50);
  const safeQuery = `"${query.replace(/"/g, '""')}"`;
  const conditions: string[] = [];
  const params: (string | number)[] = [safeQuery];

  if (options.project) {
    conditions.push("o.project = ?");
    params.push(options.project);
  }
  if (options.significance) {
    conditions.push("o.significance = ?");
    params.push(options.significance);
  }
  if (options.kind) {
    conditions.push("o.kind = ?");
    params.push(options.kind);
  }

  const whereExtra = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM observations_fts f
    JOIN observations o ON o.id = f.rowid
    WHERE observations_fts MATCH ?
    ${whereExtra}
  `).get(...params) as { cnt: number };

  const results = db.prepare(`
    SELECT o.id, o.title, o.significance, o.kind, o.created_at_epoch
    FROM observations_fts f
    JOIN observations o ON o.id = f.rowid
    WHERE observations_fts MATCH ?
    ${whereExtra}
    ORDER BY f.rank
    LIMIT ?
  `).all(...params, limit) as SearchResult[];

  return { results, total_count: countRow.cnt };
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/pipelines/search/fts.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/pipelines/search/fts.test.ts src/pipelines/search/fts.ts
git commit -m "feat: implement FTS5 search with project/significance/kind filters"
```

---

## Chunk 3: Verification

### Task 7: Run full test suite and verify

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: ALL PASS — kernel + ingest + extract + FTS

- [ ] **Step 2: Run typecheck**

Run: `bun x tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Final commit if needed**

```bash
git add -A
git status
# Only commit if there are changes
```
