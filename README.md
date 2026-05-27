<p align="center">
  <img src="src/dashboard/logo.png" alt="deja" width="120">
</p>
<p align="center">
  <strong>Claude Code forgets everything between sessions. deja fixes that.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@anandt/deja"><img src="https://img.shields.io/npm/v/@anandt/deja.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@anandt/deja"><img src="https://img.shields.io/npm/dm/@anandt/deja.svg" alt="monthly downloads"></a>
  <a href="https://github.com/anandmt/deja/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@anandt/deja.svg" alt="license"></a>
</p>

<p align="center">
  Automatic persistent memory for Claude Code.<br>
  Zero config. 100% local. No API keys.
</p>

---

## The problem

Every time you start a new Claude Code session, it starts from scratch. The architectural decisions you made yesterday? Gone. The bug you spent an hour debugging? Forgotten. The coding conventions you established? You'll explain them again.

**deja gives Claude a memory.** It silently observes your sessions — files touched, commands run, decisions made — and feeds the most relevant context back at the start of every new session. No configuration. No cloud. Just continuity.

## Install

```bash
npm install -g @anandt/deja
deja install
```

That's it. Bun is auto-installed if missing. Start a new Claude Code session and you'll see:

```
+- d e j a ---------------------------------+
|                                            |
|  > 142 memories :: 12 sessions :: 3h ago   |
|  > Dashboard :: http://localhost:19533      |
|                                            |
+--------------------------------------------+
```

## What Claude remembers

Every session, deja quietly captures:

- **Files you touched** — reads, edits, and writes with full context
- **Commands you ran** — shell commands and their output
- **Decisions you made** — architectural choices, trade-offs, and reasoning
- **Session summaries** — compressed snapshots of what happened

Next session, the most relevant memories are automatically injected. Claude picks up where you left off.

## How it works

```
You use Claude Code normally
        |
  deja silently observes via hooks
        |
  Events are classified, compressed, and stored
        |
  Next session starts
        |
  deja injects relevant context automatically
        |
  Claude remembers.
```

No manual tagging. No "save this." No commands to run. It just works.

## In-session recall

Claude can search its own memory mid-session using built-in MCP tools:

| Tool | What it does |
|---|---|
| `deja_search` | Search across all memories by keyword |
| `deja_timeline` | See chronological context around any event |
| `deja_observe` | Get full details for specific observations |

> "What was that API endpoint I set up last week?"
> Claude searches its memory and finds it.

## Dashboard

```bash
deja dashboard
```

A local web dashboard at `http://localhost:19533` — browse observation timelines, project stats, and session history. Your memory, visualized.

## Privacy

**100% local.** Everything lives in a single SQLite file at `~/.deja/memory.db`. No cloud. No external services. No API keys. No data ever leaves your machine.

Storage is efficient — roughly 250 MB per year of heavy daily use.

## Commands

| Command | Description |
|---|---|
| `deja install` | Install hooks and MCP server |
| `deja uninstall` | Remove hooks, MCP server, and stop processes |
| `deja uninstall --purge` | Full removal including all data (~/.deja) |
| `deja search <query>` | Search your memories |
| `deja stats` | Show project statistics |
| `deja dashboard` | Open the local dashboard |

## Requirements

- **macOS or Linux** (Windows: manual Bun install required)
- **Bun >= 1.3.6** (auto-installed if missing)
- **Claude Code**

## License

MIT
