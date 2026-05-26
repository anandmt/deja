import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "../kernel/db";
import { runMigrations } from "../kernel/migrations";
import { handleSearch, handleTimeline, handleObserve } from "./tools";
import { join } from "path";
import { homedir } from "os";

const dbPath = process.env.DEJA_DB_PATH ?? join(homedir(), ".deja", "memory.db");
const db = openDb(dbPath);
runMigrations(db);

const server = new McpServer({
  name: "deja",
  version: "0.1.0",
});

server.tool(
  "deja_search",
  "Search observations by keyword. Returns lightweight index (id, title, significance, kind, date). Use this FIRST before deja_observe.",
  {
    query: z.string().describe("Search query"),
    project: z.string().optional().describe("Filter by project path"),
    significance: z.enum(["low", "medium", "high", "critical"]).optional().describe("Filter by significance level"),
    kind: z.enum(["file_read", "file_edit", "file_write", "bash_cmd", "decision", "prompt"]).optional().describe("Filter by observation kind"),
    limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20, max 50)"),
  },
  async (args) => handleSearch(db, args),
);

server.tool(
  "deja_timeline",
  "Get chronological context around an observation (same session only). Shows what happened before and after.",
  {
    anchor: z.number().int().describe("Observation ID to center timeline around"),
    depth_before: z.number().int().min(0).max(20).optional().describe("Items before anchor (default 5)"),
    depth_after: z.number().int().min(0).max(20).optional().describe("Items after anchor (default 5)"),
  },
  async (args) => handleTimeline(db, args),
);

server.tool(
  "deja_observe",
  "Fetch full observation details by ID. HARD CAP: max 10 IDs per request. Always filter through deja_search first.",
  {
    ids: z.array(z.number().int()).min(1).max(10).describe("Observation IDs to fetch (max 10)"),
  },
  async (args) => handleObserve(db, args),
);

const transport = new StdioServerTransport();
await server.connect(transport);
