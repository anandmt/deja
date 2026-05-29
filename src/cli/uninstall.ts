import { readFileSync, writeFileSync, existsSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { paths } from "../paths";

const DEJA_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];

function stopWorker(): void {
  try {
    if (!existsSync(paths.workerPid)) return;
    const pid = parseInt(readFileSync(paths.workerPid, "utf-8").trim(), 10);
    if (isNaN(pid)) return;
    process.kill(pid, "SIGTERM");
    console.log(`  Stopped worker process (PID ${pid})`);
  } catch (e: any) {
    if (e.code !== "ESRCH") return;
  }
}

function stopDashboard(): void {
  try {
    if (existsSync(paths.dashboardPid)) {
      const pid = parseInt(readFileSync(paths.dashboardPid, "utf-8").trim(), 10);
      if (!isNaN(pid)) {
        process.kill(pid, "SIGTERM");
        console.log(`  Stopped dashboard process (PID ${pid})`);
        return;
      }
    }
  } catch (e: any) {
    if (e.code !== "ESRCH") { /* fall through to lsof */ }
  }
  try {
    const pids = execSync("lsof -ti:19533 2>/dev/null", { encoding: "utf-8" }).trim();
    if (!pids) return;
    for (const pid of pids.split("\n")) {
      try {
        process.kill(parseInt(pid, 10), "SIGTERM");
        console.log(`  Stopped dashboard process (PID ${pid})`);
      } catch {}
    }
  } catch {}
}

function removeSocket(): void {
  try {
    if (existsSync(paths.workerSock)) unlinkSync(paths.workerSock);
  } catch {}
}

function removeClaudeSettings(overrideClaudeDir?: string): boolean {
  const settingsPath = join(overrideClaudeDir ?? join(homedir(), ".claude"), "settings.json");
  if (!existsSync(settingsPath)) return false;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    let changed = false;

    if (settings.hooks) {
      for (const event of DEJA_HOOK_EVENTS) {
        if (settings.hooks[event]) {
          delete settings.hooks[event];
          changed = true;
        }
      }
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
    }

    if (settings.mcpServers?.deja) {
      delete settings.mcpServers.deja;
      if (Object.keys(settings.mcpServers).length === 0) {
        delete settings.mcpServers;
      }
      changed = true;
    }

    if (changed) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
    return changed;
  } catch {
    return false;
  }
}

function removeDataDir(): void {
  if (!existsSync(paths.dejaDir)) return;
  rmSync(paths.dejaDir, { recursive: true, force: true });
  console.log(`  Removed ${paths.dejaDir}`);
}

export function uninstall(options?: { purge?: boolean; overrideClaudeDir?: string }): void {
  const { purge = false, overrideClaudeDir } = options ?? {};

  stopWorker();
  stopDashboard();
  removeSocket();

  if (removeClaudeSettings(overrideClaudeDir)) {
    console.log("  Removed hooks and MCP server from ~/.claude/settings.json");
  }

  if (purge) {
    removeDataDir();
  }
}
