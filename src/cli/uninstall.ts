import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DEJA_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];

export function uninstall(overrideClaudeDir?: string): void {
  const settingsPath = join(overrideClaudeDir ?? join(homedir(), ".claude"), "settings.json");
  if (!existsSync(settingsPath)) return;

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
  } catch {}
}
