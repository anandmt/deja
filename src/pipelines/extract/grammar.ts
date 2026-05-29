import { Parser, Language } from "web-tree-sitter";
import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync } from "fs";
import { join } from "path";

const WASM_CDN_BASE = "https://unpkg.com/tree-sitter-wasms@0.1.13/out";
const DOWNLOAD_TIMEOUT_MS = 10_000;
const NEGATIVE_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
      const language = await Language.load(readFileSync(wasmPath));
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
