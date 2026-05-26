import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";

function getHooksJson(): object {
  const hooksPath = resolve(import.meta.dir, "..", "..", "hooks.json");
  return JSON.parse(readFileSync(hooksPath, "utf-8"));
}

function getMcpEntry(): { command: string; args: string[] } {
  const serverScript = resolve(import.meta.dir, "..", "mcp", "server.ts");
  return { command: "bun", args: ["run", serverScript] };
}

export function install(projectDir: string): void {
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const hooksPath = join(claudeDir, "hooks.json");
  writeFileSync(hooksPath, JSON.stringify(getHooksJson(), null, 2) + "\n");

  const settingsPath = join(claudeDir, "settings.json");
  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {}
  }

  if (!settings.mcpServers) settings.mcpServers = {};
  settings.mcpServers.deja = getMcpEntry();

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}
