import { describe, test, expect, afterEach } from "bun:test";
import { detectLanguage, GrammarManager } from "../../../src/pipelines/extract/grammar";
import { mkdtempSync, existsSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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

describe("GrammarManager", () => {
  let grammarDir: string;

  afterEach(() => {
    if (grammarDir) rmSync(grammarDir, { recursive: true, force: true });
  });

  test("returns null for unknown language", async () => {
    grammarDir = mkdtempSync(join(tmpdir(), "deja-grammar-test-"));
    const manager = new GrammarManager(grammarDir);
    const result = await manager.getParser("/project/data.xyz");
    expect(result).toBeNull();
  });

  test("loads parser from disk-cached .wasm file", async () => {
    grammarDir = mkdtempSync(join(tmpdir(), "deja-grammar-test-"));
    const resp = await fetch(
      "https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-typescript.wasm"
    );
    const wasmBytes = await resp.arrayBuffer();
    writeFileSync(join(grammarDir, "tree-sitter-typescript.wasm"), Buffer.from(wasmBytes));

    const manager = new GrammarManager(grammarDir);
    const parser = await manager.getParser("/project/src/auth.ts");
    expect(parser).not.toBeNull();
  });

  test("returns null and creates .none marker on 404", async () => {
    grammarDir = mkdtempSync(join(tmpdir(), "deja-grammar-test-"));
    const manager = new GrammarManager(grammarDir);
    const result = await manager.getParserForLanguage("fakefakelang");
    expect(result).toBeNull();
    expect(existsSync(join(grammarDir, "tree-sitter-fakefakelang.none"))).toBe(true);
  });

  test("skips download when .none marker exists and is fresh", async () => {
    grammarDir = mkdtempSync(join(tmpdir(), "deja-grammar-test-"));
    writeFileSync(join(grammarDir, "tree-sitter-fakefakelang.none"), "");
    const manager = new GrammarManager(grammarDir);
    const result = await manager.getParserForLanguage("fakefakelang");
    expect(result).toBeNull();
  });

  test("memory cache returns same parser instance on second call", async () => {
    grammarDir = mkdtempSync(join(tmpdir(), "deja-grammar-test-"));
    const resp = await fetch(
      "https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-typescript.wasm"
    );
    const wasmBytes = await resp.arrayBuffer();
    writeFileSync(join(grammarDir, "tree-sitter-typescript.wasm"), Buffer.from(wasmBytes));

    const manager = new GrammarManager(grammarDir);
    const parser1 = await manager.getParser("/project/a.ts");
    const parser2 = await manager.getParser("/project/b.tsx");
    expect(parser1).toBe(parser2);
  });
});
