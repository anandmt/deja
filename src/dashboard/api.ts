import type { Database } from "bun:sqlite";

export interface Overview {
  sessions: number;
  observations: number;
  active_sessions: number;
  by_significance: Record<string, number>;
  stats: Record<string, number>;
}

export function getOverview(db: Database, project: string): Overview {
  const sessions = (db.prepare(
    "SELECT COUNT(*) as cnt FROM sessions WHERE project = ?",
  ).get(project) as { cnt: number }).cnt;

  const observations = (db.prepare(
    "SELECT COUNT(*) as cnt FROM observations WHERE project = ?",
  ).get(project) as { cnt: number }).cnt;

  const sigRows = db.prepare(
    "SELECT significance, COUNT(*) as cnt FROM observations WHERE project = ? GROUP BY significance",
  ).all(project) as { significance: string; cnt: number }[];

  const by_significance: Record<string, number> = {};
  for (const row of sigRows) {
    by_significance[row.significance] = row.cnt;
  }

  const statsRows = db.prepare(
    "SELECT metric, value FROM stats WHERE project = ?",
  ).all(project) as { metric: string; value: number }[];

  const stats: Record<string, number> = {};
  for (const row of statsRows) {
    stats[row.metric] = row.value;
  }

  const active_sessions = (db.prepare(
    "SELECT COUNT(*) as cnt FROM sessions WHERE project = ? AND ended_at_epoch IS NULL",
  ).get(project) as { cnt: number }).cnt;

  return { sessions, observations, active_sessions, by_significance, stats };
}

export interface RecentObservation {
  id: number;
  significance: string;
  kind: string;
  title: string;
  created_at_epoch: number;
}

export function getRecentObservations(db: Database, project: string, limit: number): RecentObservation[] {
  return db.prepare(
    `SELECT id, significance, kind, title, created_at_epoch
     FROM observations WHERE project = ?
     ORDER BY created_at_epoch DESC LIMIT ?`,
  ).all(project, limit) as RecentObservation[];
}

export interface SessionRow {
  id: string;
  started_at_epoch: number;
  ended_at_epoch: number | null;
  summary: string | null;
  obs_count: number;
}

export function getSessions(db: Database, project: string, limit: number): SessionRow[] {
  return db.prepare(
    `SELECT s.id, s.started_at_epoch, s.ended_at_epoch, s.summary,
       (SELECT COUNT(*) FROM observations o WHERE o.session_id = s.id) as obs_count
     FROM sessions s WHERE s.project = ?
     ORDER BY s.started_at_epoch DESC LIMIT ?`,
  ).all(project, limit) as SessionRow[];
}

export interface ProjectRow {
  project: string;
  session_count: number;
  last_active: number;
}

export function getProjects(db: Database): ProjectRow[] {
  return db.prepare(
    `SELECT project, COUNT(*) as session_count, MAX(started_at_epoch) as last_active
     FROM sessions GROUP BY project ORDER BY last_active DESC`,
  ).all() as ProjectRow[];
}

export interface DeleteResult {
  observations: number;
  sessions: number;
}

export function deleteProject(db: Database, project: string): DeleteResult {
  const countObs = db.prepare("SELECT COUNT(*) as cnt FROM observations WHERE project = ?");
  const countSess = db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE project = ?");
  const delObs = db.prepare("DELETE FROM observations WHERE project = ?");
  const delSess = db.prepare("DELETE FROM sessions WHERE project = ?");
  const delStats = db.prepare("DELETE FROM stats WHERE project = ?");

  const tx = db.transaction(() => {
    const observations = (countObs.get(project) as { cnt: number }).cnt;
    const sessions = (countSess.get(project) as { cnt: number }).cnt;
    delObs.run(project);
    delSess.run(project);
    delStats.run(project);
    return { observations, sessions };
  });

  return tx();
}

export function hasActiveSessions(db: Database, project: string): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM sessions WHERE project = ? AND ended_at_epoch IS NULL",
  ).get(project) as { cnt: number };
  return row.cnt > 0;
}
