# Configuration

deja works out of the box with no configuration. All settings are optional overrides.

## Settings file

```
~/.deja/settings.json
```

Created automatically on first run. You only need to specify the values you want to change — deja deep-merges your overrides with the defaults.

## Settings reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `context_budget` | `number` | `8000` | Max characters injected at session start (~2000 tokens) |
| `tiers.ast` | `boolean` | `false` | Enable tree-sitter AST extraction ([Tier 1](#tiers)) |
| `tiers.vectors` | `boolean` | `false` | Enable sqlite-vec embeddings (Tier 2, planned) |
| `llm.enabled` | `boolean` | `false` | Enable LLM extraction (Tier 3, planned) |
| `llm.provider` | `string \| null` | `null` | LLM provider: `"anthropic"`, `"gemini"`, or custom |
| `llm.model` | `string \| null` | `null` | Model identifier (e.g., `"claude-sonnet-4-20250514"`) |
| `llm.base_url` | `string \| null` | `null` | Custom API base URL for self-hosted models |
| `retention` | `string \| null` | `null` | Auto-prune observations older than this (e.g., `"90d"`, `"1y"`) |
| `cross_project` | `boolean` | `false` | Include insights from other projects in context injection |
| `log_level` | `string` | `"warn"` | Logging verbosity: `error` \| `warn` \| `info` \| `debug` |
| `log_max_days` | `number` | `30` | Days to keep log files before rotation |
| `excluded_projects` | `string[]` | `[]` | Project paths to ignore completely |
| `debounce_ms` | `number` | `100` | Event batching window in milliseconds |
| `worker_idle_timeout_minutes` | `number` | `30` | Worker auto-shutdown after idle period |
| `tcp_port` | `number` | `19532` | TCP port for Windows IPC (macOS/Linux use Unix socket) |

## Example: partial override

```json
{
  "tiers": { "ast": true },
  "cross_project": true,
  "context_budget": 12000
}
```

Only the fields you specify are overridden. Everything else keeps its default value.

## Environment variables

API keys are **never stored** in `settings.json`. Set them in your shell environment:

| Variable | Used by |
|----------|---------|
| `ANTHROPIC_API_KEY` | Tier 3 LLM extraction (Anthropic provider) |
| `GEMINI_API_KEY` | Tier 3 LLM extraction (Gemini provider) |
| `DEJA_LLM_API_KEY` | Tier 3 LLM extraction (custom provider) |
| `DEJA_DB_PATH` | Override database location (default: `~/.deja/memory.db`) |

## Data location

All deja data lives under `~/.deja/`:

```
~/.deja/
├── memory.db          # SQLite database (WAL mode)
├── settings.json      # Configuration overrides
├── grammars/          # Downloaded tree-sitter WASM files (Tier 1)
├── logs/              # Rotating log files
├── worker.pid         # Worker process ID
├── worker.sock        # Unix domain socket (macOS/Linux)
└── pending.wal        # Failover write-ahead log
```
