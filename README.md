# deja

Zero-config persistent memory for Claude Code.

deja captures file reads, edits, shell commands, and decisions via Claude Code hooks. It compresses them locally and injects relevant context into future sessions. Everything lives in a single SQLite file with no external services.

## Install

```bash
npm install -g @anandt/deja
deja install
```

Bun is installed automatically if not already present.

> **Quick try:** `npx @anandt/deja install` works but hook paths may break when npx clears its cache. Use global install for permanent setup.

## How it works

deja installs four Claude Code hooks and an MCP server into `~/.claude/settings.json`.

**What it captures:**
- Files you read, edit, and write
- Shell commands and their output
- Decisions and architectural context
- Session summaries

**Context injection:** At the start of each session, deja reads your memory database and injects the most relevant context — last session summary, high-significance observations, and cross-project insights.

**MCP tools** for in-session use:
- `deja_search` — keyword search across observations
- `deja_timeline` — chronological context around a specific observation
- `deja_observe` — full details for specific observation IDs

## Dashboard

```bash
deja dashboard
```

Opens a local dashboard at http://localhost:19533 showing observation timelines, project statistics, and session history.

## Commands

```
deja install               Install hooks and MCP server
deja uninstall             Remove hooks and MCP server
deja search <query>        Search observations
deja stats                 Show project statistics
deja dashboard             Open live dashboard
```

## Requirements

- **macOS or Linux** (Windows: manual Bun install required)
- **Bun >= 1.3.6** (auto-installed if missing)
- **Claude Code**

## Data storage

All data lives in `~/.deja/memory.db` (SQLite with WAL mode). Typical storage is ~250 MB per year of heavy use. No data leaves your machine.

## License

MIT
