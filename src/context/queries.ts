import type { Database } from "bun:sqlite";

export interface SessionSummaryRow {
  id: string;
  summary: string;
  started_at_epoch: number;
  ended_at_epoch: number | null;
}

export interface ObservationRow {
  id: number;
  significance: string;
  kind: string;
  title: string;
  content: string;
  facts: string;
  concepts: string;
  created_at_epoch: number;
}

export interface CrossProjectRow extends ObservationRow {
  project: string;
  shared_concepts: number;
}

export function getLastSessionSummary(
  db: Database,
  project: string,
): SessionSummaryRow | null {
  const row = db.prepare(`
    SELECT id, summary, started_at_epoch, ended_at_epoch
    FROM sessions
    WHERE project = ? AND summary IS NOT NULL AND summary != ''
    ORDER BY started_at_epoch DESC
    LIMIT 1
  `).get(project) as SessionSummaryRow | null;
  return row ?? null;
}

export function getTopObservations(
  db: Database,
  project: string,
  limit: number,
): ObservationRow[] {
  return db.prepare(`
    SELECT id, significance, kind, title, content, facts, concepts, created_at_epoch
    FROM observations
    WHERE project = ? AND significance IN ('medium', 'high', 'critical')
    ORDER BY
      CASE significance
        WHEN 'critical' THEN 4
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        ELSE 1
      END DESC,
      created_at_epoch DESC
    LIMIT ?
  `).all(project, limit) as ObservationRow[];
}

export function getCrossProjectInsights(
  db: Database,
  currentProject: string,
  maxInsights: number,
): CrossProjectRow[] {
  const localRows = db.prepare(`
    SELECT concepts FROM observations
    WHERE project = ? AND significance IN ('high', 'critical')
    ORDER BY created_at_epoch DESC LIMIT 50
  `).all(currentProject) as { concepts: string }[];

  const localConcepts = new Set<string>();
  for (const row of localRows) {
    try {
      const arr = JSON.parse(row.concepts) as string[];
      for (const c of arr) localConcepts.add(c);
    } catch {}
  }

  if (localConcepts.size === 0) return [];

  const candidates = db.prepare(`
    SELECT id, significance, kind, title, content, facts, concepts, created_at_epoch, project
    FROM observations
    WHERE project != ? AND significance IN ('high', 'critical')
    ORDER BY created_at_epoch DESC LIMIT 200
  `).all(currentProject) as (ObservationRow & { project: string })[];

  const matches: CrossProjectRow[] = [];
  for (const candidate of candidates) {
    try {
      const arr = JSON.parse(candidate.concepts) as string[];
      let shared = 0;
      for (const c of arr) {
        if (localConcepts.has(c)) shared++;
      }
      if (shared >= 2) {
        matches.push({ ...candidate, shared_concepts: shared });
      }
    } catch {}
  }

  matches.sort((a, b) =>
    b.shared_concepts - a.shared_concepts || b.created_at_epoch - a.created_at_epoch
  );

  return matches.slice(0, maxInsights);
}
