import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readSettings,
  writeSettings,
  DEFAULT_SETTINGS,
} from "../../src/kernel/settings";

describe("settings", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deja-settings-"));
    settingsPath = join(dir, "settings.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("readSettings returns defaults when file does not exist", () => {
    const settings = readSettings(settingsPath);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  test("readSettings merges partial file with defaults", () => {
    writeFileSync(settingsPath, JSON.stringify({ context_budget: 12000 }));
    const settings = readSettings(settingsPath);
    expect(settings.context_budget).toBe(12000);
    expect(settings.log_level).toBe("warn");
    expect(settings.tiers.ast).toBe(false);
  });

  test("readSettings preserves nested overrides", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ llm: { enabled: true, provider: "claude", model: "haiku", base_url: null } })
    );
    const settings = readSettings(settingsPath);
    expect(settings.llm.enabled).toBe(true);
    expect(settings.llm.provider).toBe("claude");
  });

  test("readSettings returns defaults on corrupt JSON", () => {
    writeFileSync(settingsPath, "not json{{{");
    const settings = readSettings(settingsPath);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  test("writeSettings creates file and is readable", () => {
    const modified = { ...DEFAULT_SETTINGS, context_budget: 16000 };
    writeSettings(settingsPath, modified);
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(raw.context_budget).toBe(16000);
  });

  test("writeSettings roundtrips through readSettings", () => {
    const modified = { ...DEFAULT_SETTINGS, log_level: "debug" as const };
    writeSettings(settingsPath, modified);
    const result = readSettings(settingsPath);
    expect(result.log_level).toBe("debug");
  });

  test("DEFAULT_SETTINGS matches spec defaults", () => {
    expect(DEFAULT_SETTINGS.context_budget).toBe(8000);
    expect(DEFAULT_SETTINGS.tiers.ast).toBe(false);
    expect(DEFAULT_SETTINGS.tiers.vectors).toBe(false);
    expect(DEFAULT_SETTINGS.llm.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.retention).toBeNull();
    expect(DEFAULT_SETTINGS.cross_project).toBe(false);
    expect(DEFAULT_SETTINGS.log_level).toBe("warn");
    expect(DEFAULT_SETTINGS.log_max_days).toBe(30);
    expect(DEFAULT_SETTINGS.excluded_projects).toEqual([]);
    expect(DEFAULT_SETTINGS.debounce_ms).toBe(100);
    expect(DEFAULT_SETTINGS.worker_idle_timeout_minutes).toBe(30);
    expect(DEFAULT_SETTINGS.tcp_port).toBe(19532);
  });
});
