import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { install } from "../../src/cli/install";
import { uninstall } from "../../src/cli/uninstall";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "deja-cli-test-"));
}

describe("install", () => {
  let tmpDir: string;
  afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

  test("creates .claude dir and copies hooks", () => {
    tmpDir = makeTmpDir();
    install(tmpDir);

    const hooksPath = join(tmpDir, ".claude", "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);

    const hooks = JSON.parse(readFileSync(hooksPath, "utf-8"));
    expect(hooks.hooks).toBeDefined();
    expect(hooks.hooks.SessionStart).toBeDefined();
    expect(hooks.hooks.PostToolUse).toBeDefined();
    expect(hooks.hooks.Stop).toBeDefined();
  });

  test("registers MCP server in settings.json", () => {
    tmpDir = makeTmpDir();
    install(tmpDir);

    const settingsPath = join(tmpDir, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.mcpServers).toBeDefined();
    expect(settings.mcpServers.deja).toBeDefined();
    expect(settings.mcpServers.deja.command).toBe("bun");
  });

  test("preserves existing settings.json entries", () => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-tool" } }, permissions: { allow: ["Read"] } }),
    );

    install(tmpDir);

    const settings = JSON.parse(readFileSync(join(tmpDir, ".claude", "settings.json"), "utf-8"));
    expect(settings.mcpServers.other.command).toBe("other-tool");
    expect(settings.mcpServers.deja).toBeDefined();
    expect(settings.permissions.allow).toEqual(["Read"]);
  });

  test("hook commands use absolute paths", () => {
    tmpDir = makeTmpDir();
    install(tmpDir);

    const hooks = JSON.parse(readFileSync(join(tmpDir, ".claude", "hooks.json"), "utf-8"));
    const cmd = hooks.hooks.SessionStart[0].hooks[0].command as string;
    expect(cmd).not.toContain("./dist");
    expect(cmd).toContain("/dist/hooks/session-start.js");
    expect(cmd.startsWith("bun /")).toBe(true);
  });

  test("is idempotent — running twice doesn't break anything", () => {
    tmpDir = makeTmpDir();
    install(tmpDir);
    install(tmpDir);

    const hooks = JSON.parse(readFileSync(join(tmpDir, ".claude", "hooks.json"), "utf-8"));
    expect(hooks.hooks.SessionStart).toBeDefined();
  });
});

describe("uninstall", () => {
  let tmpDir: string;
  afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

  test("removes hooks.json", () => {
    tmpDir = makeTmpDir();
    install(tmpDir);
    expect(existsSync(join(tmpDir, ".claude", "hooks.json"))).toBe(true);

    uninstall(tmpDir);
    expect(existsSync(join(tmpDir, ".claude", "hooks.json"))).toBe(false);
  });

  test("removes deja from MCP settings but preserves others", () => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { deja: { command: "bun" }, other: { command: "other" } } }),
    );

    uninstall(tmpDir);

    const settings = JSON.parse(readFileSync(join(tmpDir, ".claude", "settings.json"), "utf-8"));
    expect(settings.mcpServers.deja).toBeUndefined();
    expect(settings.mcpServers.other.command).toBe("other");
  });

  test("is safe to run when not installed", () => {
    tmpDir = makeTmpDir();
    expect(() => uninstall(tmpDir)).not.toThrow();
  });
});
