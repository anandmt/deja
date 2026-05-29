# Tier 1: Tree-sitter Symbol Extraction — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace regex heuristic symbol extraction with tree-sitter AST parsing for accurate symbol names in observations.

**Architecture:** The pipeline always runs `extractHeuristic()` first for the full `ExtractedObservation`. When `tiers.ast` is enabled, `extractAst()` runs second and overwrites `facts[]` and `title` with AST-derived symbols. A `GrammarManager` handles lazy WASM grammar downloads with two-layer caching (disk + memory).

**Tech Stack:** `web-tree-sitter` (WASM), Bun, SQLite, `bun:test`

**Spec:** `docs/superpowers/specs/2026-05-29-tier1-tree-sitter-extraction-design.md`

---

## Chunk 1: Bun Compatibility Spike + Grammar Manager

### Task 1: Verify web-tree-sitter works under Bun

This is the critical gate. If this fails, the entire plan needs to pivot.

**Files:**
- Create: `spike/tree-sitter-bun-test.ts` (temporary, deleted after verification)

- [ ] **Step 1: Install web-tree-sitter**

```bash
bun add web-tree-sitter@^0.25
```

- [ ] **Step 2: Download a test grammar**

```bash
mkdir -p spike
curl -L -o spike/tree-sitter-typescript.wasm \
  "https://unpkg.com/tree-sitter-wasms@0.25.3/out/tree-sitter-typescript.wasm"
```

- [ ] **Step 3: Write the spike script**

```typescript
// spike/tree-sitter-bun-test.ts
import Parser from "web-tree-sitter";

async function main() {
  await Parser.init();
  const parser = new Parser();
  const lang = await Parser.Language.load("spike/tree-sitter-typescript.wasm");
  parser.setLanguage(lang);

  const tree = parser.parse(`
    export function validateToken(token: string): boolean {
      return token.length > 0;
    }

    export class AuthService {
      refreshSession() {}
    }
  `);

  const root = tree.rootNode;
  const symbols: string[] = [];

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)!;
    if (node.type.includes("function") || node.type.includes("class")) {
      const name = node.childForFieldName("name");
      if (name) symbols.push(name.text);
    }
  }

  console.log("Symbols found:", symbols);
  if (symbols.includes("validateToken") && symbols.includes("AuthService")) {
    console.log("PASS: web-tree-sitter works under Bun");
  } else {
    console.error("FAIL: expected [validateToken, AuthService], got", symbols);
    process.exit(1);
  }
}

main();
```

- [ ] **Step 4: Run with Bun**

```bash
bun run spike/tree-sitter-bun-test.ts
```

Expected: `PASS: web-tree-sitter works under Bun`

If this fails, STOP. Read the spec's fallback strategies (native `tree-sitter` bindings via Bun's Node.js compat layer, or subprocess). Adjust `grammar.ts` design accordingly.

- [ ] **Step 5: Clean up spike**

```bash
rm -rf spike
```

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lockb
git commit -m "feat: add web-tree-sitter dependency for Tier 1 AST extraction"
```

---

### Task 2: Grammar Manager — language detection

**Files:**
- Create: `src/pipelines/extract/grammar.ts`
- Test: `tests/pipelines/extract/grammar.test.ts`

- [ ] **Step 1: Write failing test for extension-to-language mapping**

```typescript
// tests/pipelines/extract/grammar.test.ts
import { describe, test, expect } from "bun:test";
import { detectLanguage } from "../../../src/pipelines/extract/grammar";

describe("detectLanguage", () => {
  test("maps .ts to typescript", () => {
    expect(detectLanguage("/project/src/auth.ts")).toBe("typescript");
  });

  test("maps .tsx to typescript", () => {
    expect(detectLanguage("/project/src/App.tsx")).toBe("typescript");
  });

  test("maps .py to python", () => {
    expect(detectLanguage("/project/main.py")).toBe("python");
  });

  test("maps .rs to rust", () => {
    expect(detectLanguage("/project/src/main.rs")).toBe("rust");
  });

  test("maps .go to go", () => {
    expect(detectLanguage("/project/main.go")).toBe("go");
  });

  test("maps .java to java", () => {
    expect(detectLanguage("/project/App.java")).toBe("java");
  });

  test("maps .js to javascript", () => {
    expect(detectLanguage("/project/index.js")).toBe("javascript");
  });

  test("maps .jsx to javascript", () => {
    expect(detectLanguage("/project/App.jsx")).toBe("javascript");
  });

  test("maps .rb to ruby", () => {
    expect(detectLanguage("/project/app.rb")).toBe("ruby");
  });

  test("maps .swift to swift", () => {
    expect(detectLanguage("/project/App.swift")).toBe("swift");
  });

  test("maps .kt to kotlin", () => {
    expect(detectLanguage("/project/Main.kt")).toBe("kotlin");
  });

  test("maps .c to c", () => {
    expect(detectLanguage("/project/main.c")).toBe("c");
  });

  test("maps .cpp to cpp", () => {
    expect(detectLanguage("/project/main.cpp")).toBe("cpp");
  });

  test("maps .cs to c_sharp", () => {
    expect(detectLanguage("/project/Program.cs")).toBe("c_sharp");
  });

  test("returns null for unknown extension", () => {
    expect(detectLanguage("/project/data.xyz")).toBeNull();
  });

  test("returns null for no extension", () => {
    expect(detectLanguage("/project/Makefile")).toBeNull();
  });

  test("handles dotfiles", () => {
    expect(detectLanguage("/project/.gitignore")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/pipelines/extract/grammar.test.ts
```

Expected: FAIL — `detectLanguage` does not exist.

- [ ] **Step 3: Implement detectLanguage**

```typescript
// src/pipelines/extract/grammar.ts
import Parser from "web-tree-sitter";

const EXTENSION_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "c_sharp",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  dart: "dart",
  lua: "lua",
  php: "php",
  vue: "vue",
  svelte: "svelte",
};

export function detectLanguage(filePath: string): string | null {
  const lastDot = filePath.lastIndexOf(".");
  const lastSlash = filePath.lastIndexOf("/");
  if (lastDot <= lastSlash) return null;
  const ext = filePath.slice(lastDot + 1);
  return EXTENSION_MAP[ext] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/pipelines/extract/grammar.test.ts
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipelines/extract/grammar.ts tests/pipelines/extract/grammar.test.ts
git commit -m "feat(grammar): add file extension to language detection"
```

---

### Task 3: Grammar Manager — download, caching, and loading

**Files:**
- Modify: `src/pipelines/extract/grammar.ts`
- Test: `tests/pipelines/extract/grammar.test.ts`

- [ ] **Step 1: Write failing test for GrammarManager.getParser()**

```typescript
// Add to tests/pipelines/extract/grammar.test.ts
import { GrammarManager } from "../../../src/pipelines/extract/grammar";
import { mkdtempSync, existsSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach } from "bun:test";

describe("GrammarManager", () => {
  let grammarDir: string;
  let manager: GrammarManager;

  afterEach(() => {
    if (grammarDir) rmSync(grammarDir, { recursive: true, force: true });
  });

  test("returns null for unknown language", async () => {
    grammarDir = mkdtempSync(join(tmpdir(), "deja-grammar-test-"));
    manager = new GrammarManager(grammarDir);
    const result = await manager.getParser("/project/data.xyz");
    expect(result).toBeNull();
  });

  test("loads parser from disk-cached .wasm file", async () => {
    grammarDir = mkdtempSync(join(tmpdir(), "deja-grammar-test-"));
    // Pre-download a real grammar to the cache dir
    const resp = await fetch(
      "https://unpkg.com/tree-sitter-wasms@0.25.3/out/tree-sitter-typescript.wasm"
    );
    const wasmBytes = await resp.arrayBuffer();
    writeFileSync(join(grammarDir, "tree-sitter-typescript.wasm"), Buffer.from(wasmBytes));

    manager = new GrammarManager(grammarDir);
    const parser = await manager.getParser("/project/src/auth.ts");
    expect(parser).not.toBeNull();
  });

  test("returns null and creates .none marker on 404", async () => {
    grammarDir = mkdtempSync(join(tmpdir(), "deja-grammar-test-"));
    manager = new GrammarManager(grammarDir);
    // "fakefakelang" won't exist on CDN
    const result = await manager.getParserForLanguage("fakefakelang");
    expect(result).toBeNull();
    expect(existsSync(join(grammarDir, "tree-sitter-fakefakelang.none"))).toBe(true);
  });

  test("skips download when .none marker exists and is fresh", async () => {
    grammarDir = mkdtempSync(join(tmpdir(), "deja-grammar-test-"));
    // Create a fresh negative marker
    writeFileSync(join(grammarDir, "tree-sitter-fakefakelang.none"), "");
    manager = new GrammarManager(grammarDir);
    const result = await manager.getParserForLanguage("fakefakelang");
    expect(result).toBeNull();
  });

  test("memory cache returns same parser instance on second call", async () => {
    grammarDir = mkdtempSync(join(tmpdir(), "deja-grammar-test-"));
    const resp = await fetch(
      "https://unpkg.com/tree-sitter-wasms@0.25.3/out/tree-sitter-typescript.wasm"
    );
    const wasmBytes = await resp.arrayBuffer();
    writeFileSync(join(grammarDir, "tree-sitter-typescript.wasm"), Buffer.from(wasmBytes));

    manager = new GrammarManager(grammarDir);
    const parser1 = await manager.getParser("/project/a.ts");
    const parser2 = await manager.getParser("/project/b.tsx");
    expect(parser1).toBe(parser2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/pipelines/extract/grammar.test.ts
```

Expected: FAIL — `GrammarManager` does not exist.

- [ ] **Step 3: Implement GrammarManager**

```typescript
// Add to src/pipelines/extract/grammar.ts (below detectLanguage)
import { existsSync, mkdirSync, writeFileSync, statSync } from "fs";
import { join } from "path";

const WASM_CDN_BASE = "https://unpkg.com/tree-sitter-wasms@0.25.3/out";
const DOWNLOAD_TIMEOUT_MS = 10_000;
const NEGATIVE_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class GrammarManager {
  private parserCache = new Map<string, Parser>();
  private initPromise: Promise<void> | null = null;

  constructor(private grammarDir: string) {
    if (!existsSync(grammarDir)) {
      mkdirSync(grammarDir, { recursive: true });
    }
  }

  async getParser(filePath: string): Promise<Parser | null> {
    const lang = detectLanguage(filePath);
    if (!lang) return null;
    return this.getParserForLanguage(lang);
  }

  async getParserForLanguage(lang: string): Promise<Parser | null> {
    if (this.parserCache.has(lang)) return this.parserCache.get(lang)!;

    await this.ensureInit();

    const wasmPath = join(this.grammarDir, `tree-sitter-${lang}.wasm`);
    const nonePath = join(this.grammarDir, `tree-sitter-${lang}.none`);

    if (this.hasValidNegativeMarker(nonePath)) return null;

    if (!existsSync(wasmPath)) {
      const downloaded = await this.download(lang, wasmPath, nonePath);
      if (!downloaded) return null;
    }

    try {
      const language = await Parser.Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(language);
      this.parserCache.set(lang, parser);
      return parser;
    } catch {
      return null;
    }
  }

  private async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = Parser.init();
    }
    await this.initPromise;
  }

  private hasValidNegativeMarker(nonePath: string): boolean {
    if (!existsSync(nonePath)) return false;
    try {
      const mtime = statSync(nonePath).mtimeMs;
      return Date.now() - mtime < NEGATIVE_MARKER_TTL_MS;
    } catch {
      return false;
    }
  }

  private async download(
    lang: string,
    wasmPath: string,
    nonePath: string,
  ): Promise<boolean> {
    const url = `${WASM_CDN_BASE}/tree-sitter-${lang}.wasm`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });

        if (resp.status === 404) {
          writeFileSync(nonePath, "");
          return false;
        }

        if (!resp.ok) continue;

        const bytes = await resp.arrayBuffer();
        writeFileSync(wasmPath, Buffer.from(bytes));
        return true;
      } catch {
        if (attempt === 1) break;
      }
    }

    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/pipelines/extract/grammar.test.ts
```

Expected: All PASS. (Note: tests that download from CDN require network. They'll be slow on first run.)

- [ ] **Step 5: Commit**

```bash
git add src/pipelines/extract/grammar.ts tests/pipelines/extract/grammar.test.ts
git commit -m "feat(grammar): add GrammarManager with lazy download and two-layer cache"
```

---

## Chunk 2: AST Extractor

### Task 4: Core extractAst() — universal symbol extraction

**Files:**
- Create: `src/pipelines/extract/ast.ts`
- Test: `tests/pipelines/extract/ast.test.ts`

- [ ] **Step 1: Write failing test for TypeScript extraction**

```typescript
// tests/pipelines/extract/ast.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { extractAst } from "../../../src/pipelines/extract/ast";
import { GrammarManager } from "../../../src/pipelines/extract/grammar";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Helper to set up a GrammarManager with a pre-downloaded grammar
async function setupManager(lang: string): Promise<{ manager: GrammarManager; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "deja-ast-test-"));
  const resp = await fetch(
    `https://unpkg.com/tree-sitter-wasms@0.25.3/out/tree-sitter-${lang}.wasm`
  );
  writeFileSync(join(dir, `tree-sitter-${lang}.wasm`), Buffer.from(await resp.arrayBuffer()));
  return { manager: new GrammarManager(dir), dir };
}

describe("extractAst", () => {
  let cleanupDir: string | null = null;
  afterEach(() => {
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = null;
  });

  test("extracts TypeScript functions and classes", async () => {
    const { manager, dir } = await setupManager("typescript");
    cleanupDir = dir;

    const code = `
export function validateToken(token: string): boolean {
  return token.length > 0;
}

export class AuthService {
  refreshSession() {}
  logout() {}
}

interface UserPayload {
  id: string;
}

enum Role {
  Admin,
  User,
}
`;

    const symbols = await extractAst(code, "/project/src/auth.ts", manager);
    expect(symbols).not.toBeNull();
    expect(symbols).toContain("validateToken");
    expect(symbols).toContain("AuthService");
    expect(symbols).toContain("refreshSession");
    expect(symbols).toContain("logout");
    expect(symbols).toContain("UserPayload");
    expect(symbols).toContain("Role");
  });

  test("extracts Python functions and classes", async () => {
    const { manager, dir } = await setupManager("python");
    cleanupDir = dir;

    const code = `
def process_payment(amount: float) -> bool:
    return amount > 0

class PaymentGateway:
    def charge(self, amount):
        pass

    def refund(self, tx_id):
        pass
`;

    const symbols = await extractAst(code, "/project/payments.py", manager);
    expect(symbols).not.toBeNull();
    expect(symbols).toContain("process_payment");
    expect(symbols).toContain("PaymentGateway");
    expect(symbols).toContain("charge");
    expect(symbols).toContain("refund");
  });

  test("returns null for unsupported file extension", async () => {
    const { manager, dir } = await setupManager("typescript");
    cleanupDir = dir;
    const result = await extractAst("some content", "/project/data.xyz", manager);
    expect(result).toBeNull();
  });

  test("returns null for empty content", async () => {
    const { manager, dir } = await setupManager("typescript");
    cleanupDir = dir;
    const result = await extractAst("", "/project/empty.ts", manager);
    expect(result).toBeNull();
  });

  test("returns empty array for file with no declarations", async () => {
    const { manager, dir } = await setupManager("typescript");
    cleanupDir = dir;
    const result = await extractAst("const x = 1 + 2;\nconsole.log(x);", "/project/script.ts", manager);
    expect(result).not.toBeNull();
    expect(result).toEqual([]);
  });

  test("deduplicates symbol names", async () => {
    const { manager, dir } = await setupManager("typescript");
    cleanupDir = dir;
    // Overloaded function declarations in TS can produce duplicates
    const code = `
function process(a: string): void;
function process(a: number): void;
function process(a: string | number): void {}
`;
    const symbols = await extractAst(code, "/project/overload.ts", manager);
    expect(symbols).not.toBeNull();
    const processCount = symbols!.filter(s => s === "process").length;
    expect(processCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/pipelines/extract/ast.test.ts
```

Expected: FAIL — `extractAst` does not exist.

- [ ] **Step 3: Implement extractAst**

```typescript
// src/pipelines/extract/ast.ts
import type { GrammarManager } from "./grammar";

const DECLARATION_KEYWORDS = [
  "function", "method", "class", "struct",
  "interface", "enum", "trait", "type", "module", "impl",
];

const BODY_CONTAINER_KEYWORDS = ["class", "struct", "impl", "module"];

function isDeclarationNode(nodeType: string): boolean {
  return DECLARATION_KEYWORDS.some((kw) => nodeType.includes(kw));
}

function isBodyContainer(nodeType: string): boolean {
  return BODY_CONTAINER_KEYWORDS.some((kw) => nodeType.includes(kw));
}

function extractNameFromNode(node: any): string | null {
  const name = node.childForFieldName("name");
  if (name) return name.text;
  return null;
}

export async function extractAst(
  content: string,
  filePath: string,
  manager: GrammarManager,
): Promise<string[] | null> {
  if (!content || content.length === 0) return null;

  const parser = await manager.getParser(filePath);
  if (!parser) return null;

  let tree;
  try {
    tree = parser.parse(content);
  } catch {
    return null;
  }

  const symbols: string[] = [];
  const root = tree.rootNode;

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i)!;

    if (isDeclarationNode(node.type)) {
      const name = extractNameFromNode(node);
      if (name) {
        symbols.push(name);
      } else {
        for (let j = 0; j < node.childCount; j++) {
          const child = node.child(j)!;
          const childName = extractNameFromNode(child);
          if (childName) symbols.push(childName);
        }
      }
    }

    if (isBodyContainer(node.type)) {
      const body = node.childForFieldName("body");
      if (body) {
        for (let j = 0; j < body.childCount; j++) {
          const member = body.child(j)!;
          if (isDeclarationNode(member.type)) {
            const name = extractNameFromNode(member);
            if (name) symbols.push(name);
          }
        }
      }
    }
  }

  return [...new Set(symbols)];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/pipelines/extract/ast.test.ts
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipelines/extract/ast.ts tests/pipelines/extract/ast.test.ts
git commit -m "feat(ast): add universal symbol extraction via tree-sitter"
```

---

### Task 5: Additional language tests (Go, Rust, Java)

These tests validate the universal extraction strategy across languages with different node-type conventions.

**Files:**
- Modify: `tests/pipelines/extract/ast.test.ts`

- [ ] **Step 1: Add Go extraction test**

```typescript
// Add to describe("extractAst") in tests/pipelines/extract/ast.test.ts

  test("extracts Go functions and type declarations", async () => {
    const { manager, dir } = await setupManager("go");
    cleanupDir = dir;

    const code = `package main

func HandleRequest(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
}

type Config struct {
	Port int
	Host string
}

type Handler interface {
	ServeHTTP()
}
`;

    const symbols = await extractAst(code, "/project/main.go", manager);
    expect(symbols).not.toBeNull();
    expect(symbols).toContain("HandleRequest");
    expect(symbols).toContain("Config");
    expect(symbols).toContain("Handler");
  });
```

- [ ] **Step 2: Add Rust extraction test**

```typescript
  test("extracts Rust functions, structs, and enums", async () => {
    const { manager, dir } = await setupManager("rust");
    cleanupDir = dir;

    const code = `
pub fn process_event(ev: &Event) -> Result<()> {
    Ok(())
}

struct Config {
    port: u16,
}

enum Status {
    Active,
    Inactive,
}
`;

    const symbols = await extractAst(code, "/project/src/main.rs", manager);
    expect(symbols).not.toBeNull();
    expect(symbols).toContain("process_event");
    expect(symbols).toContain("Config");
    expect(symbols).toContain("Status");
  });
```

- [ ] **Step 3: Add Java extraction test**

```typescript
  test("extracts Java classes and methods", async () => {
    const { manager, dir } = await setupManager("java");
    cleanupDir = dir;

    const code = `
public class UserService {
    public User findById(String id) {
        return null;
    }

    public void deleteUser(String id) {
    }
}
`;

    const symbols = await extractAst(code, "/project/UserService.java", manager);
    expect(symbols).not.toBeNull();
    expect(symbols).toContain("UserService");
    expect(symbols).toContain("findById");
    expect(symbols).toContain("deleteUser");
  });
```

- [ ] **Step 4: Run all AST tests**

```bash
bun test tests/pipelines/extract/ast.test.ts
```

Expected: All PASS. If a language fails, investigate the tree-sitter node types (add a debug helper that prints the AST) and adjust the universal extraction strategy in `ast.ts` if needed. The heuristic fallback covers any misses.

- [ ] **Step 5: Commit**

```bash
git add tests/pipelines/extract/ast.test.ts
git commit -m "test(ast): add Go, Rust, and Java extraction tests"
```

---

## Chunk 3: Pipeline Integration

### Task 6: Wire AST extraction into the pipeline

**Files:**
- Modify: `src/worker/pipeline.ts`
- Modify: `tests/worker/pipeline.test.ts`

- [ ] **Step 1: Write failing integration test**

Add to `tests/worker/pipeline.test.ts`:

```typescript
import { GrammarManager } from "../../src/pipelines/extract/grammar";

// Add test inside describe("Pipeline")
  test("AST extraction overwrites facts when tiers.ast is enabled", async () => {
    db = tmpDb();
    runMigrations(db);

    // Create a temp grammar dir with a pre-downloaded TS grammar
    const grammarDir = mkdtempSync(join(tmpdir(), "deja-pipeline-grammar-"));
    const resp = await fetch(
      "https://unpkg.com/tree-sitter-wasms@0.25.3/out/tree-sitter-typescript.wasm"
    );
    writeFileSync(
      join(grammarDir, "tree-sitter-typescript.wasm"),
      Buffer.from(await resp.arrayBuffer()),
    );
    const grammarManager = new GrammarManager(grammarDir);

    const astSettings = { ...DEFAULT_SETTINGS, tiers: { ast: true, vectors: false } };
    const pipeline = new Pipeline(db, astSettings, noop, grammarManager);

    // Write a TS file to a temp location so the pipeline can read it for Edit events
    const tempFile = join(grammarDir, "auth.ts");
    writeFileSync(tempFile, `export function validateToken(t: string): boolean { return true; }\nexport class AuthService { refresh() {} }`);

    await pipeline.processEvent(
      {
        type: "PostToolUse",
        session_id: "test-session",
        cwd: "/project",
        tool: "Edit",
        input: {
          file_path: tempFile,
          old_string: "return true;",
          new_string: "return false;",
        },
        output: { success: true },
      } as HookPayload,
      defaultBatch(),
    );

    const obs = db.query("SELECT * FROM observations WHERE id = 1").get() as any;
    const facts = JSON.parse(obs.facts);
    expect(facts).toContain("validateToken");
    expect(facts).toContain("AuthService");
    expect(facts).toContain("refresh");
    expect(obs.title).toContain("validateToken");

    rmSync(grammarDir, { recursive: true, force: true });
  });

  test("falls back to heuristic when tiers.ast is disabled", async () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);

    await pipeline.processEvent(editPayload(), defaultBatch());

    const obs = db.query("SELECT * FROM observations WHERE id = 1").get() as any;
    expect(obs).not.toBeNull();
    expect(obs.kind).toBe("file_edit");
    // Heuristic extraction still works as before
  });

  test("falls back to heuristic for unsupported file extension with no errors", async () => {
    db = tmpDb();
    runMigrations(db);

    const grammarDir = mkdtempSync(join(tmpdir(), "deja-pipeline-grammar-"));
    const grammarManager = new GrammarManager(grammarDir);
    const astSettings = { ...DEFAULT_SETTINGS, tiers: { ast: true, vectors: false } };
    const pipeline = new Pipeline(db, astSettings, noop, grammarManager);

    await pipeline.processEvent(
      {
        type: "PostToolUse",
        session_id: "test-session",
        cwd: "/project",
        tool: "Write",
        input: {
          file_path: "/project/data.xyz",
          content: "some unknown format content",
        },
        output: { success: true },
      } as HookPayload,
      defaultBatch(),
    );

    const obs = db.query("SELECT * FROM observations WHERE id = 1").get() as any;
    expect(obs).not.toBeNull();
    expect(obs.kind).toBe("file_write");
    // Heuristic extraction produced the observation — no crash, no missing data

    rmSync(grammarDir, { recursive: true, force: true });
  });
```

Note: You'll also need to add these imports at the top of the test file:

```typescript
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/worker/pipeline.test.ts
```

Expected: FAIL — `Pipeline` constructor does not accept a `GrammarManager` parameter.

- [ ] **Step 3: Modify Pipeline to accept optional GrammarManager**

Update `src/worker/pipeline.ts`:

```typescript
// Add imports at top
import { extractAst } from "../pipelines/extract/ast";
import type { GrammarManager } from "../pipelines/extract/grammar";
import { readFileSync, statSync } from "fs";

const MAX_AST_FILE_SIZE = 500 * 1024; // 500KB
const MAX_TITLE_SYMBOLS = 5;
```

Update the `Pipeline` class constructor to accept an optional `GrammarManager`:

```typescript
  constructor(
    db: Database,
    private settings: Settings,
    private log: Logger,
    private grammarManager?: GrammarManager,
  ) {
```

Change `processEvent` to be `async` and add AST extraction after heuristic extraction. The key change is at line 87 where `extractHeuristic` is called — add the AST overlay logic right after:

```typescript
  async processEvent(payload: HookPayload, batch: BatchAnnotation): Promise<void> {
    // ... existing code through line 87 ...

    const normalized = normalize(payload);
    const extracted = extractHeuristic(normalized, classified);

    // AST overlay: overwrite facts and title when tree-sitter succeeds
    if (
      this.settings.tiers.ast &&
      this.grammarManager &&
      (normalized.action === "edit" || normalized.action === "write")
    ) {
      const content = this.resolveFileContent(normalized);
      if (content && content.length <= MAX_AST_FILE_SIZE) {
        const filePath = normalized.files[0];
        if (filePath) {
          try {
            const symbols = await extractAst(content, filePath, this.grammarManager);
            if (symbols && symbols.length > 0) {
              extracted.facts = symbols;
              extracted.title = this.buildAstTitle(normalized.action, filePath, symbols);
            }
          } catch {
            // AST failed silently, heuristic extraction stands
          }
        }
      }
    }

    this.stmtInsertObs.run(
      // ... existing args unchanged ...
    );

    // ... rest unchanged ...
  }

  private resolveFileContent(normalized: NormalizedEvent): string | null {
    if (normalized.action === "write") {
      try {
        const raw = JSON.parse(normalized.raw_event);
        return (raw.input?.content ?? null) as string | null;
      } catch {
        return null;
      }
    }

    // Edit events: read from disk
    const filePath = normalized.files[0];
    if (!filePath) return null;
    try {
      const stat = statSync(filePath);
      if (stat.size > MAX_AST_FILE_SIZE) return null;
      return readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  private buildAstTitle(action: string, filePath: string, symbols: string[]): string {
    const lastSlash = filePath.lastIndexOf("/");
    const filename = lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
    const prefix = action === "write" ? "Created" : "Edit";
    const shown = symbols.slice(0, MAX_TITLE_SYMBOLS);
    const suffix = symbols.length > MAX_TITLE_SYMBOLS
      ? ` + ${symbols.length - MAX_TITLE_SYMBOLS} more`
      : "";
    return `${prefix} ${filename} — ${shown.join(", ")}${suffix}`;
  }
```

- [ ] **Step 4: Update all existing tests for async processEvent**

`processEvent` is now `async`, so every existing test that calls it must use `await` and be an `async` function. Update all 14 existing test calls in `tests/worker/pipeline.test.ts`:

```typescript
// Every test function that calls processEvent must become async:
//   test("...", () => {        →  test("...", async () => {
//   pipeline.processEvent(...) →  await pipeline.processEvent(...)

// Full list of tests to update (22 calls across 15 tests):
// 1. "processes Edit event into stored observation" — 1 call
// 2. "auto-creates session on first event" — 1 call
// 3. "does not duplicate session on second event" — 2 calls
// 4. "skips noise events (node_modules read)" — 1 call
// 5. "increments events_skipped stat for skipped events" — 1 call
// 6. "increments events_stored stat for stored events" — 1 call
// 7. "Write event classified as critical (new source file)" — 1 call
// 8. "tracks seenWritePaths — second write to same file is not critical" — 2 calls
// 9. "decision prompt classified as critical" — 1 call
// 10. "observation content is searchable via FTS" — 1 call
// 11. "Stop sets ended_at_epoch on session" — 3 calls (SessionStart + editPayload + Stop)
// 12. "Stop generates heuristic summary from observations" — 4 calls (SessionStart + writePayload + editPayload + Stop)
// 13. "processes bash command into observation" — 1 call
//
// SessionStart and Stop events also go through processEvent, so those calls need await too.
// "SessionStart creates session record but no observation" — 1 call
// "Stop is safe when session does not exist" — 1 call (inside expect().not.toThrow() — 
//   must change to: await expect(async () => { await pipeline.processEvent(...); }).not.toThrow())
```

Example pattern for each test:

```typescript
// BEFORE:
test("processes Edit event into stored observation", () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);
    pipeline.processEvent(editPayload(), defaultBatch());
    // ...assertions...
});

// AFTER:
test("processes Edit event into stored observation", async () => {
    db = tmpDb();
    runMigrations(db);
    const pipeline = new Pipeline(db, DEFAULT_SETTINGS, noop);
    await pipeline.processEvent(editPayload(), defaultBatch());
    // ...assertions...
});
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/worker/pipeline.test.ts
```

Expected: All PASS (both new tests and all existing tests).

- [ ] **Step 6: Run the full test suite to check for regressions**

```bash
bun test
```

Expected: All tests pass. Existing tests that don't pass a `GrammarManager` skip the AST path entirely — heuristic behavior is unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/worker/pipeline.ts tests/worker/pipeline.test.ts
git commit -m "feat(pipeline): integrate AST extraction with heuristic fallback"
```

---

### Task 7: Wire GrammarManager and async callers in the worker

`processEvent` is now `async`. Three callers must be updated: the WAL drain loop, the debouncer callback, and the `EmitFn` type in `debounce.ts`.

**Files:**
- Modify: `src/worker/main.ts`
- Modify: `src/pipelines/ingest/debounce.ts`

- [ ] **Step 1: Update `EmitFn` type in debounce.ts to accept async callbacks**

In `src/pipelines/ingest/debounce.ts`, the `EmitFn` type is synchronous:

```typescript
// BEFORE (line 3):
type EmitFn = (payload: HookPayload, batch: BatchAnnotation) => void;

// AFTER:
type EmitFn = (payload: HookPayload, batch: BatchAnnotation) => void | Promise<void>;
```

This is a type-only change. The Debouncer itself calls `this.emit(...)` without `await` — the Promise is fire-and-forget from the debouncer's perspective. The caller (main.ts) wraps it in a try/catch that handles the async error.

- [ ] **Step 2: Update main.ts — add GrammarManager + make main() async + update callers**

In `src/worker/main.ts`:

```typescript
// Add imports at top:
import { GrammarManager } from "../pipelines/extract/grammar";
import { join } from "path";
import { homedir } from "os";

// Change main() to async:
async function main(): Promise<void> {
  // ... existing setup (mkdirSync, openDb, runMigrations, readSettings, createLogger, etc.) ...

  // Add GrammarManager creation before Pipeline instantiation (after line 25):
  const grammarManager = settings.tiers.ast
    ? new GrammarManager(join(homedir(), ".deja", "grammars"))
    : undefined;

  const pipeline = new Pipeline(db, settings, log, grammarManager);

  // Update WAL drain loop to await processEvent (lines 37-44):
  // BEFORE:
  //   for (const eventJson of walEvents) {
  //     try {
  //       const payload = JSON.parse(eventJson) as HookPayload;
  //       pipeline.processEvent(payload, defaultBatch);
  //     } catch (err) { ... }
  //   }
  //
  // AFTER:
  for (const eventJson of walEvents) {
    try {
      const payload = JSON.parse(eventJson) as HookPayload;
      await pipeline.processEvent(payload, defaultBatch);
    } catch (err) {
      log("error", "worker", `Failed to process WAL event: ${err}`);
    }
  }

  // Update debouncer callback to handle async (lines 47-53):
  // BEFORE:
  //   const debouncer = new Debouncer(settings.debounce_ms, (payload, batch) => {
  //     try {
  //       pipeline.processEvent(payload, batch);
  //     } catch (err) {
  //       log("error", "worker", `Pipeline error: ${err}`);
  //     }
  //   });
  //
  // AFTER:
  const debouncer = new Debouncer(settings.debounce_ms, (payload, batch) => {
    pipeline.processEvent(payload, batch).catch((err) => {
      log("error", "worker", `Pipeline error: ${err}`);
    });
  });

  // ... rest of main() unchanged ...
}

main().catch((err) => {
  console.error("Worker startup failed:", err);
  process.exit(1);
});
```

**Key decisions:**
- WAL drain uses `await` because events must process sequentially (order matters for classification state like `seenWritePaths`).
- Debouncer callback uses `.catch()` fire-and-forget because the debouncer calls `this.emit()` synchronously in a `for` loop. The events still process in order because `processEvent` runs to completion before the next event's async work starts (single-threaded JS event loop), but errors are caught instead of becoming unhandled rejections.

- [ ] **Step 3: Run the full test suite**

```bash
bun test
```

Expected: All PASS. Worker wiring doesn't affect tests since tests construct `Pipeline` directly.

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: No errors. The `EmitFn` type change is compatible with both sync and async callbacks.

- [ ] **Step 5: Commit**

```bash
git add src/worker/main.ts src/pipelines/ingest/debounce.ts
git commit -m "feat(worker): wire GrammarManager and update callers for async processEvent"
```

---

### Task 8: Manual smoke test

- [ ] **Step 1: Enable tiers.ast in settings**

```bash
# Edit ~/.deja/settings.json and set tiers.ast to true
# Or create it if it doesn't exist:
echo '{"tiers":{"ast":true}}' > ~/.deja/settings.json
```

- [ ] **Step 2: Start the worker manually**

```bash
bun run src/worker/main.ts
```

Verify it starts without errors. Check that `~/.deja/grammars/` is created.

- [ ] **Step 3: Trigger an edit event**

Open a Claude Code session and edit a TypeScript file. Check the worker logs for:
- Grammar download message (first time only)
- `Stored:` log with symbol names in the title

- [ ] **Step 4: Verify observation in the database**

```bash
sqlite3 ~/.deja/memory.db "SELECT title, facts FROM observations ORDER BY id DESC LIMIT 5"
```

Verify that recent observations have accurate symbol names in `facts`.

- [ ] **Step 5: Disable tiers.ast and reset**

```bash
echo '{"tiers":{"ast":false}}' > ~/.deja/settings.json
```

- [ ] **Step 6: Commit any fixes discovered during smoke test**

If the smoke test revealed issues, fix them and commit:

```bash
git add -u
git commit -m "fix: address issues found during Tier 1 smoke test"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run the full test suite one final time**

```bash
bun test
```

Expected: All PASS.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: No errors.

- [ ] **Step 3: Run build**

```bash
bun run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 4: Review all changes**

```bash
git log --oneline main..HEAD
git diff main --stat
```

Verify:
- `web-tree-sitter` added to `package.json` dependencies
- `src/pipelines/extract/grammar.ts` created (language detection + GrammarManager)
- `src/pipelines/extract/ast.ts` created (universal symbol extraction)
- `src/worker/pipeline.ts` modified (AST overlay in processEvent)
- `src/worker/main.ts` modified (GrammarManager instantiation)
- Tests created for grammar.ts, ast.ts, and pipeline integration
- No changes to: schema, migrations, MCP tools, hooks, dashboard, context injection, CLI
