import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";

function resolveFile(base: string, ...segments: string[]): string {
  const tsPath = resolve(base, ...segments) + ".ts";
  if (existsSync(tsPath)) return tsPath;
  const jsPath = resolve(base, ...segments) + ".js";
  if (existsSync(jsPath)) return jsPath;
  return tsPath;
}

function getHooksJson(): object {
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

  return config;
}

function getMcpEntry(): { command: string; args: string[] } {
  const serverScript = resolveFile(import.meta.dir, "..", "mcp", "server");
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
