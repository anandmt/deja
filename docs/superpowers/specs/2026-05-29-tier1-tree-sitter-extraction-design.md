# Tier 1: Tree-sitter Symbol Extraction

**Date:** 2026-05-29
**Status:** Draft
**Scope:** Replace regex heuristics with tree-sitter AST parsing for accurate symbol extraction in observations

## Problem

Deja's heuristic extractor (`extract/heuristic.ts`) uses regex to guess symbol names from file content. It misses symbols, misidentifies them, and produces unreliable `facts` for FTS search. An observation that should say "edited `validateToken` and `refreshSession`" often says just "edited `auth.ts`."

## Solution

Add `extract/ast.ts` as the primary extraction stage when tree-sitter is available. It parses files into ASTs and extracts top-level symbol names (functions, classes, methods, structs, enums). When no grammar is available, the pipeline falls back silently to `heuristic.ts`.

No schema changes. No new MCP tools. No new tables. The output shape (`ExtractedObservation`) is identical to what `heuristic.ts` produces today.

## Design Principles

- **Language-agnostic.** No per-language code. Symbol extraction uses universal tree-sitter node-type conventions.
- **Zero config.** Language detected from file extension. Grammars downloaded and cached automatically.
- **Graceful degradation.** Missing grammar or parse failure falls back to regex heuristics. The user never sees an error.
- **Background only.** All tree-sitter work happens in the worker process. SessionStart, hooks, and MCP are unaffected.

## Architecture

### Pipeline Integration

```
Normalized Event
    │
    ├─ No file content? ──────────▶ heuristic.ts (full extraction)
    ├─ tiers.ast disabled? ───────▶ heuristic.ts (full extraction)
    ├─ kind is bash_cmd or prompt? ▶ heuristic.ts (no file to parse)
    ├─ File > 500KB? ─────────────▶ heuristic.ts (too large to parse)
    ├─ No grammar available? ─────▶ heuristic.ts (full extraction)
    ├─ Parse/extract fails? ──────▶ heuristic.ts (full extraction)
    │
    ▼
  heuristic.ts first ──▶ full ExtractedObservation (kind, title, content, facts, concepts, files_read, files_modified)
    │
    ▼
  ast.ts second ──▶ overwrites facts[] and title with AST-derived symbols
    │
    ▼
  Final ExtractedObservation
```

**Merge strategy.** The pipeline always calls `extractHeuristic()` first to produce the full `ExtractedObservation` (including `kind`, `content`, `files_read`, `files_modified`, and path-derived `concepts`). Then, if AST extraction is available and succeeds, `extractAst()` returns a list of symbol names. The pipeline overwrites `facts` with the AST-derived symbols and rebuilds `title` to include them. All other fields remain as heuristic produced them.

This means ast.ts has a narrow interface: it takes file content and returns `string[]` (symbol names) or `null` (fallback). It does not produce a full `ExtractedObservation`.

The rest of the pipeline (store, FTS indexing) is unchanged.

### Grammar Manager (`src/pipelines/extract/grammar.ts`)

Manages tree-sitter WASM grammars. Three responsibilities:

**Language detection.** A lookup table maps file extensions to grammar names (~30 entries). `.ts`/`.tsx` → `typescript`, `.py` → `python`, `.rs` → `rust`. Unknown extensions return null, triggering heuristic fallback.

**Lazy download.** On first encounter with a language, downloads the WASM grammar (~200-500KB) and saves to `~/.deja/grammars/<language>.wasm`. No upfront scanning, no install-time setup.

Download source: the [`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms) npm package provides pre-built WASM grammars with consistent ABI versions. Grammars are fetched from the npm CDN with a **pinned version** (e.g., `https://unpkg.com/tree-sitter-wasms@0.25.3/out/tree-sitter-<language>.wasm`). The pinned version is stored as a constant in `grammar.ts` and updated manually when `web-tree-sitter` is upgraded.

**Self-hosting consideration:** If unpkg availability or supply chain risk proves problematic, migrate WASM files to GitHub Releases on the Deja repo. The download URL is a single constant — switching sources is a one-line change.

Download behavior:
- HTTP timeout: 10 seconds
- Retries once on network error or 5xx response
- On 404 (grammar does not exist for this language): caches a negative marker file (`~/.deja/grammars/<language>.none`) to prevent repeated download attempts. Negative markers are checked before any HTTP call. **Negative markers expire after 30 days** (checked via file mtime) to allow rediscovery when new grammars are published.
- On final failure: returns null, triggering heuristic fallback. Logs a warning at `debug` level.
- Uses Bun's built-in `fetch`.

**Two-layer cache.** Disk cache (`~/.deja/grammars/`) survives worker restarts. Memory cache of loaded `Parser` instances avoids re-initializing WASM per event. The WASM runtime itself (`web-tree-sitter`) initializes once per worker lifetime.

```
~/.deja/grammars/
├── typescript.wasm
├── python.wasm
├── rust.wasm
└── ...
```

Grammars are downloaded once and cached indefinitely. Users can clear `~/.deja/grammars/` to force re-download (this also clears negative markers). If `web-tree-sitter` is upgraded to a new major version, the grammar cache directory should be cleared automatically on worker startup (check a `version` marker file in the grammars directory).

### AST Extractor (`src/pipelines/extract/ast.ts`)

Extracts symbol names from file content using tree-sitter. No per-language code.

**Universal extraction strategy.** Tree-sitter grammar authors follow naming conventions. Declaration nodes contain keywords like `function`, `method`, `class`, `struct`, `interface`, `enum`, `trait`, `type`, `module` in their type names. These nodes have a `name` child field holding the identifier.

One set of keyword patterns works across all languages:

```
DECLARATION_KEYWORDS = [
  "function", "method", "class", "struct",
  "interface", "enum", "trait", "type", "module", "impl"
]

For each root-level node:
  if node.type contains any DECLARATION_KEYWORD:
    name = node.childForFieldName("name")
    if name exists:
      symbols.push(name.text)
    else:
      // Container node (e.g. Go's type_declaration wraps type_spec).
      // Recurse into immediate children to find named declarations.
      for each child of node:
        if child has field "name":
          symbols.push(child.childForFieldName("name").text)

  // Recurse into class/struct/impl/module bodies for member declarations.
  // "Body node" = the `body` field of any node whose type contains
  // "class", "struct", "impl", or "module". This avoids walking into
  // object literals or function bodies.
  if node.type contains ("class" | "struct" | "impl" | "module"):
    body = node.childForFieldName("body")
    if body exists:
      for each child of body:
        if child.type contains any DECLARATION_KEYWORD:
          name = child.childForFieldName("name")
          if name exists:
            symbols.push(name.text)
```

This catches:
- TypeScript: `function_declaration`, `class_declaration`, `interface_declaration`, `method_definition`
- Python: `function_definition`, `class_definition`
- Rust: `function_item`, `struct_item`, `enum_item`, `impl_item` (impl blocks matched via `"impl"` keyword; name extracted from `type` field if present)
- Go: `function_declaration`, `method_declaration`, `type_declaration` (container node — name lives on child `type_spec`, found via the child-recursion fallback)
- Java: `method_declaration`, `class_declaration`, `interface_declaration`

If a grammar uses unconventional node names, that symbol is missed — the heuristic regex catches it as a fallback.

**Output format.** `extractAst()` returns `string[] | null` — a list of symbol names, or null if extraction failed. The pipeline merges these into the `ExtractedObservation` produced by `extractHeuristic()`:

```typescript
// ast.ts returns:
["validateToken", "refreshSession", "AuthService"]  // or null

// Pipeline merges into the heuristic-produced ExtractedObservation:
{
  kind: "file_edit",
  title: "Edit auth.ts — validateToken, refreshSession, AuthService",  // rebuilt with AST symbols
  content: "...",              // from heuristic
  facts: ["validateToken", "refreshSession", "AuthService"],           // overwritten by AST
  concepts: ["authentication", "session"],                             // from heuristic (path analysis)
  files_read: [],              // from heuristic
  files_modified: ["auth.ts"]  // from heuristic
}
```

**Event types processed.** `ast.ts` runs only on `file_edit` and `file_write` events (where file content is available and the observation represents a code change). `file_read` events are not processed — reads don't change code, and indexing every read file would add noise without improving memory quality. `bash_cmd` and `prompt` events have no file content to parse.

**File size guard.** Skip AST extraction for files larger than 500KB. Large files (minified bundles, generated code, data files) waste CPU for symbols nobody cares about. The heuristic fallback handles these.

### Configuration

The `tiers.ast` setting already exists in Deja's config (`src/kernel/settings.ts`), defaulting to `false`. When enabled, the pipeline uses `ast.ts` as the primary extractor. When disabled, behavior is identical to today.

No new settings required.

## Dependency

**`web-tree-sitter`** (`^0.25.x`) — the WASM build of tree-sitter. Pure WASM, no native bindings. ~500KB. Pinned to 0.25.x for ABI compatibility with `tree-sitter-wasms` pre-built grammars.

Deja's runtime dependencies go from one (`@modelcontextprotocol/sdk`) to two. No other new dependencies.

### Bun Compatibility (Must Verify)

The spec assumes `web-tree-sitter` works under Bun's WASM runtime. This has not been verified. **Before implementation begins**, run a proof-of-concept spike:

1. Install `web-tree-sitter` in the Deja repo
2. Download a TypeScript grammar WASM
3. Parse a sample file, extract a function name
4. Run with `bun run`

If the spike fails (e.g., Bun's `WebAssembly.instantiate` or filesystem access from WASM has edge cases), the fallback strategy is to use native `tree-sitter` bindings via Bun's Node.js compatibility layer, or to run tree-sitter in a subprocess. The spec's architecture (grammar manager + narrow `string[] | null` interface) isolates this risk — only `grammar.ts` changes.

## Performance

| Operation | Cost | Frequency |
|---|---|---|
| WASM runtime init | ~50ms | Once per worker lifetime |
| Grammar load from disk | ~20ms | Once per language per worker lifetime |
| Grammar download (network) | 1-2s | Once per language, ever |
| File parse + extract | <10ms | Every observation with file content |

All operations run in the background worker. The SessionStart hook (200ms budget) and MCP server are unaffected — symbols are already stored as facts by the time they read the DB.

## Files Changed

| File | Change |
|---|---|
| `src/pipelines/extract/ast.ts` | New — AST symbol extraction |
| `src/pipelines/extract/grammar.ts` | New — grammar download, caching, language detection |
| `src/worker/pipeline.ts` | Modified — wire ast.ts into extract stage, instantiate grammar manager in Pipeline constructor |
| `package.json` | Modified — add `web-tree-sitter` dependency |

No changes to: database schema, migrations, MCP tools, hooks, dashboard, context injection, or CLI.

## Testing

**Unit tests for `ast.ts`:**
- Parse sample code strings for 4-5 languages (TS, Python, Go, Rust, Java)
- Assert correct symbol names extracted
- Assert graceful empty return for unparseable content
- Verify universal node-type pattern catches functions, classes, methods, structs, enums

**Unit tests for `grammar.ts`:**
- Mock HTTP for download + cache-to-disk flow
- Verify memory cache hit on second call for same language
- Verify download failure returns null (signals fallback)
- Verify extension-to-language mapping

**Integration test for pipeline:**
- Process a file_edit event with `tiers.ast: true`, assert accurate symbols in stored `facts`
- Process the same event with `tiers.ast: false`, assert heuristic fallback
- Process an event for an unsupported extension, assert heuristic fallback with no errors

All tests use `bun:test`. No new test dependencies.

## What This Is Not

This is not a code graph, call graph, or structural query system. Tier 1 makes Deja's temporal memory more precise by extracting accurate symbol names. It does not track relationships between symbols, analyze blast radius, or index the codebase proactively. The scope is: better facts in observations, better FTS search results.

## Future Considerations

If symbol-level queries prove valuable, Tier 1's parsing infrastructure supports future extensions:
- **Symbols column** — structured JSON in observations for symbol-level filtering
- **Symbol index table** — separate table enabling "show me everything I did to `validateToken`"
- **Signatures** — extract parameter types alongside names

These are future decisions, not commitments.
