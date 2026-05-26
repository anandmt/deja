import { install } from "./install";
import { uninstall } from "./uninstall";
import { cliSearch } from "./search";
import { cliStats } from "./stats";
import { openDb } from "../kernel/db";
import { runMigrations } from "../kernel/migrations";
import { paths } from "../paths";

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`deja — zero-config persistent memory for Claude Code

Usage: deja <command> [options]

Commands:
  install              Install hooks and MCP server in current project
  uninstall            Remove hooks and MCP server from current project
  search <query>       Search observations by keyword
    --project <path>   Filter by project path (default: cwd)
    --significance <s> Filter: low | medium | high | critical
    --kind <k>         Filter: file_read | file_edit | file_write | bash_cmd | decision | prompt
    --limit <n>        Max results (default 20, max 50)
  stats                Show project statistics
    --project <path>   Project path (default: cwd)`);
}

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

switch (command) {
  case "install": {
    const projectDir = getFlag("--project") ?? process.cwd();
    install(projectDir);
    console.log(`deja installed in ${projectDir}`);
    break;
  }

  case "uninstall": {
    const projectDir = getFlag("--project") ?? process.cwd();
    uninstall(projectDir);
    console.log(`deja uninstalled from ${projectDir}`);
    break;
  }

  case "search": {
    const query = args[1];
    if (!query) {
      console.error("Usage: deja search <query>");
      process.exit(1);
    }
    const db = openDb(paths.db);
    runMigrations(db);
    const output = cliSearch(db, query, {
      project: getFlag("--project") ?? process.cwd(),
      significance: getFlag("--significance") as any,
      kind: getFlag("--kind"),
      limit: getFlag("--limit") ? parseInt(getFlag("--limit")!, 10) : undefined,
    });
    console.log(output);
    db.close();
    break;
  }

  case "stats": {
    const db = openDb(paths.db);
    runMigrations(db);
    const project = getFlag("--project") ?? process.cwd();
    const output = cliStats(db, project);
    console.log(output);
    db.close();
    break;
  }

  default:
    usage();
    if (command && command !== "help" && command !== "--help" && command !== "-h") {
      process.exit(1);
    }
}
