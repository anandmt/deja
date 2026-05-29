import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { install, cleanupLegacy } from "../../src/cli/install";
import { uninstall } from "../../src/cli/uninstall";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "deja-cli-test-"));
}

describe("install", () => {
  let tmpDir: string;
  afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

  test("writes hooks and MCP into settings.json", () => {
    tmpDir = makeTmpDir();
    install(tmpDir);

    const settingsPath = join(tmpDir, "settings.json");
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.mcpServers.deja).toBeDefined();
    expect(settings.mcpServers.deja.command).toBe("bun");
  });

  test("preserves existing settings entries", () => {
    tmpDir = makeTmpDir();
    writeFileSync(
      join(tmpDir, "settings.json"),
      JSON.stringify({
        model: "sonnet",
        mcpServers: { other: { command: "other-tool" } },
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );

    install(tmpDir);

    const settings = JSON.parse(readFileSync(join(tmpDir, "settings.json"), "utf-8"));
    expect(settings.model).toBe("sonnet");
    expect(settings.mcpServers.other.command).toBe("other-tool");
    expect(settings.mcpServers.deja).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
  });

  test("hook commands use absolute paths", () => {
    tmpDir = makeTmpDir();
    install(tmpDir);

    const settings = JSON.parse(readFileSync(join(tmpDir, "settings.json"), "utf-8"));
    const cmd = settings.hooks.SessionStart[0].hooks[0].command as string;
    expect(cmd).not.toContain("./dist");
    expect(cmd).toContain("/dist/hooks/session-start.js");
    expect(cmd.startsWith("bun /")).toBe(true);
  });

  test("is idempotent", () => {
    tmpDir = makeTmpDir();
    install(tmpDir);
    install(tmpDir);

    const settings = JSON.parse(readFileSync(join(tmpDir, "settings.json"), "utf-8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });
});

describe("cleanupLegacy", () => {
  let tmpDir: string;
  afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

  test("removes legacy hooks.json from project", () => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "hooks.json"), "{}");

    cleanupLegacy(tmpDir);

    expect(existsSync(join(tmpDir, ".claude", "hooks.json"))).toBe(false);
  });

  test("removes deja entries from project settings.json", () => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { SessionStart: [] },
        mcpServers: { deja: { command: "bun" }, other: { command: "x" } },
      }),
    );

    cleanupLegacy(tmpDir);

    const settings = JSON.parse(readFileSync(join(tmpDir, ".claude", "settings.json"), "utf-8"));
    expect(settings.hooks).toBeUndefined();
    expect(settings.mcpServers.deja).toBeUndefined();
    expect(settings.mcpServers.other.command).toBe("x");
  });

  test("deletes empty project settings.json", () => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { deja: { command: "bun" } } }),
    );

    cleanupLegacy(tmpDir);

    expect(existsSync(join(tmpDir, ".claude", "settings.json"))).toBe(false);
  });

  test("is safe when no .claude dir exists", () => {
    tmpDir = makeTmpDir();
    expect(() => cleanupLegacy(tmpDir)).not.toThrow();
  });
});

describe("uninstall", () => {
  let tmpDir: string;
  afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

  test("removes deja hooks and MCP from settings", () => {
    tmpDir = makeTmpDir();
    install(tmpDir);

    const before = JSON.parse(readFileSync(join(tmpDir, "settings.json"), "utf-8"));
    expect(before.hooks).toBeDefined();
    expect(before.mcpServers.deja).toBeDefined();

    uninstall({ overrideClaudeDir: tmpDir });

    const after = JSON.parse(readFileSync(join(tmpDir, "settings.json"), "utf-8"));
    expect(after.hooks).toBeUndefined();
    expect(after.mcpServers).toBeUndefined();
  });

  test("preserves non-deja hooks and MCP entries", () => {
    tmpDir = makeTmpDir();
    writeFileSync(
      join(tmpDir, "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "deja" }] }],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint" }] }],
        },
        mcpServers: { deja: { command: "bun" }, other: { command: "other" } },
        model: "opus",
      }),
    );

    uninstall({ overrideClaudeDir: tmpDir });

    const settings = JSON.parse(readFileSync(join(tmpDir, "settings.json"), "utf-8"));
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.SessionStart).toBeUndefined();
    expect(settings.mcpServers.other.command).toBe("other");
    expect(settings.mcpServers.deja).toBeUndefined();
    expect(settings.model).toBe("opus");
  });

  test("is safe when settings.json doesn't exist", () => {
    tmpDir = makeTmpDir();
    expect(() => uninstall({ overrideClaudeDir: tmpDir })).not.toThrow();
  });
});
