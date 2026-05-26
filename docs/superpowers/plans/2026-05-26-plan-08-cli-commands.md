# Plan 8: CLI Commands — install, uninstall, search, stats

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `deja` CLI entry point with four subcommands: `install` (copies hooks.json to Claude Code project config), `uninstall` (removes it), `search` (FTS query from terminal), and `stats` (display project stats). After this plan, users can run `deja install`, `deja search "auth"`, etc.

**Architecture:** A thin dispatcher (`src/cli/main.ts`) parses `process.argv` and calls the appropriate handler. Each subcommand is a separate file in `src/cli/` with a single exported function. All are pure functions that take explicit dependencies (paths, DB) — unit-testable without side effects.

**Tech Stack:** No extra dependencies. Bun's built-in APIs for file I/O, process.argv for arg parsing.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/cli/main.ts` | Entry point: parse argv, dispatch to subcommand |
| `src/cli/install.ts` | Copy hooks.json + register MCP server in Claude Code config |
| `src/cli/uninstall.ts` | Remove hooks.json + deregister MCP server |
| `src/cli/search.ts` | FTS search from terminal, formatted output |
| `src/cli/stats.ts` | Display project stats from stats table |
| `tests/cli/install.test.ts` | Tests for install/uninstall |
| `tests/cli/search.test.ts` | Tests for search handler |
| `tests/cli/stats.test.ts` | Tests for stats handler |

---

## Chunk 1: Install / Uninstall

### Task 1: Tests + implementation for install and uninstall

**Files:**
- Create: `tests/cli/install.test.ts`
- Create: `src/cli/install.ts`
- Create: `src/cli/uninstall.ts`

The install command:
1. Copies `hooks.json` from the deja package root to `.claude/hooks.json` in the target project
2. Registers the MCP server in `.claude/settings.json` under `mcpServers.deja`
3. Creates `.claude/` dir if needed

The uninstall command reverses both.

---

## Chunk 2: Search + Stats

### Task 2: Tests + implementation for search

**Files:**
- Create: `tests/cli/search.test.ts`
- Create: `src/cli/search.ts`

Search opens the DB, runs FTS, formats results for terminal output.

### Task 3: Tests + implementation for stats

**Files:**
- Create: `tests/cli/stats.test.ts`
- Create: `src/cli/stats.ts`

Stats reads the stats table and observation counts, formats for terminal.

---

## Chunk 3: CLI Entry Point

### Task 4: Main dispatcher + final verification

**Files:**
- Create: `src/cli/main.ts`
