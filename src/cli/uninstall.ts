import { rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export function uninstall(projectDir: string): void {
  const claudeDir = join(projectDir, ".claude");

  const hooksPath = join(claudeDir, "hooks.json");
  if (existsSync(hooksPath)) {
    rmSync(hooksPath);
  }

  const settingsPath = join(claudeDir, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (settings.mcpServers?.deja) {
        delete settings.mcpServers.deja;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      }
    } catch {}
  }
}
