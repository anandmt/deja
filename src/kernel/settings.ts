import { readFileSync, writeFileSync } from "fs";
import type { Settings } from "../types";

export const DEFAULT_SETTINGS: Settings = {
  context_budget: 8000,
  tiers: { ast: false, vectors: false },
  llm: { enabled: false, provider: null, model: null, base_url: null },
  retention: null,
  cross_project: false,
  log_level: "warn",
  log_max_days: 30,
  excluded_projects: [],
  debounce_ms: 100,
  worker_idle_timeout_minutes: 30,
  tcp_port: 19532,
};

function deepMerge(defaults: any, overrides: any): any {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (
      typeof defaults[key] === "object" &&
      defaults[key] !== null &&
      !Array.isArray(defaults[key]) &&
      typeof overrides[key] === "object" &&
      overrides[key] !== null &&
      !Array.isArray(overrides[key])
    ) {
      result[key] = deepMerge(defaults[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

export function readSettings(path: string): Settings {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return deepMerge(DEFAULT_SETTINGS, parsed) as Settings;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

export function writeSettings(path: string, settings: Settings): void {
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}
