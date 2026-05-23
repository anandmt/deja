import type { Database } from "bun:sqlite";
import type { ExtractedObservation, Significance } from "../../types";

export function storeObservation(
  db: Database,
  sessionId: string,
  project: string,
  significance: Significance,
  obs: ExtractedObservation,
  rawEvent: string,
  createdAtEpoch: number,
): number {
  const stmt = db.prepare(`
    INSERT INTO observations (session_id, project, significance, kind, title, content,
      facts, concepts, files_read, files_modified, raw_event, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    sessionId,
    project,
    significance,
    obs.kind,
    obs.title,
    obs.content,
    JSON.stringify(obs.facts),
    JSON.stringify(obs.concepts),
    JSON.stringify(obs.files_read),
    JSON.stringify(obs.files_modified),
    rawEvent,
    createdAtEpoch,
  );
  return Number(result.lastInsertRowid);
}
