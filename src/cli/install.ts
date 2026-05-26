import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

function getHooksConfig(): Record<string, unknown> {
  const dejaRoot = resolve(import.meta.dir, "..", "..");
  const hooksPath = resolve(dejaRoot, "hooks.json");
  const config = JSON.parse(readFileSync(hooksPath, "utf-8"));

  const distHooks = resolve(dejaRoot, "dist", "hooks");
  for (const matchers of Object.values(config.hooks) as any[][]) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        if (hook.command) {
          hook.command = hook.command.replace(
            /\.\/dist\/hooks\//g,
            distHooks + "/",
          );
        }
      }
    }
  }

  return config.hooks;
}

function getMcpEntry(): { command: string; args: string[] } {
  const dejaRoot = resolve(import.meta.dir, "..", "..");
  const serverScript = resolve(dejaRoot, "dist", "mcp", "server.js");
  return { command: "bun", args: ["run", serverScript] };
}

export function install(overrideClaudeDir?: string): void {
  const claudeDir = overrideClaudeDir ?? join(homedir(), ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, "settings.json");
  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {}
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = getHooksConfig();
  for (const [event, matchers] of Object.entries(hooks)) {
    settings.hooks[event] = matchers;
  }

  if (!settings.mcpServers) settings.mcpServers = {};
  settings.mcpServers.deja = getMcpEntry();

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

export function cleanupLegacy(projectDir: string): void {
  const claudeDir = join(projectDir, ".claude");

  const legacyHooksPath = join(claudeDir, "hooks.json");
  if (existsSync(legacyHooksPath)) {
    rmSync(legacyHooksPath);
  }

  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) return;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    let changed = false;
    if (settings.hooks) { delete settings.hooks; changed = true; }
    if (settings.mcpServers?.deja) { delete settings.mcpServers.deja; changed = true; }
    if (changed) {
      if (Object.keys(settings.mcpServers ?? {}).length === 0) delete settings.mcpServers;
      if (Object.keys(settings).length === 0) {
        rmSync(settingsPath);
      } else {
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      }
    }
  } catch {}
}
