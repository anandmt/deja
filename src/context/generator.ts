import type { Database } from "bun:sqlite";
import type { Settings } from "../types";

export function generateContext(
  _db: Database,
  _project: string,
  _sessionId: string,
  _settings: Settings,
): string {
  return "";
}
