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

export interface SearchObservationsOptions {
  project: string;
  query?: string;
  significance?: string;
  dateFrom?: number;
  dateTo?: number;
  sortBy?: "time" | "id";
  sortDir?: "asc" | "desc";
  limit?: number;
}

export function searchObservations(db: Database, opts: SearchObservationsOptions): RecentObservation[] {
  const limit = Math.min(opts.limit ?? 100, 200);
  const params: (string | number)[] = [];
  let sql: string;

  if (opts.query?.trim()) {
    const safeQuery = `"${opts.query.replace(/"/g, '""')}"`;
    params.push(safeQuery);

    const conditions: string[] = ["o.project = ?"];
    params.push(opts.project);

    if (opts.significance) {
      conditions.push("o.significance = ?");
      params.push(opts.significance);
    }
    if (opts.dateFrom) {
      conditions.push("o.created_at_epoch >= ?");
      params.push(opts.dateFrom);
    }
    if (opts.dateTo) {
      conditions.push("o.created_at_epoch <= ?");
      params.push(opts.dateTo);
    }

    const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    let orderBy = "f.rank";
    if (opts.sortBy === "time") {
      orderBy = `o.created_at_epoch ${opts.sortDir === "asc" ? "ASC" : "DESC"}`;
    } else if (opts.sortBy === "id") {
      orderBy = `o.id ${opts.sortDir === "asc" ? "ASC" : "DESC"}`;
    }

    sql = `SELECT o.id, o.significance, o.kind, o.title, o.created_at_epoch
           FROM observations_fts f
           JOIN observations o ON o.id = f.rowid
           WHERE observations_fts MATCH ?
           ${where}
           ORDER BY ${orderBy}
           LIMIT ?`;
  } else {
    const conditions: string[] = ["project = ?"];
    params.push(opts.project);

    if (opts.significance) {
      conditions.push("significance = ?");
      params.push(opts.significance);
    }
    if (opts.dateFrom) {
      conditions.push("created_at_epoch >= ?");
      params.push(opts.dateFrom);
    }
    if (opts.dateTo) {
      conditions.push("created_at_epoch <= ?");
      params.push(opts.dateTo);
    }

    const where = conditions.join(" AND ");
    let orderBy = `created_at_epoch ${opts.sortDir === "asc" ? "ASC" : "DESC"}`;
    if (opts.sortBy === "id") {
      orderBy = `id ${opts.sortDir === "asc" ? "ASC" : "DESC"}`;
    }

    sql = `SELECT id, significance, kind, title, created_at_epoch
           FROM observations WHERE ${where}
           ORDER BY ${orderBy}
           LIMIT ?`;
  }

  params.push(limit);
  return db.prepare(sql).all(...params) as RecentObservation[];
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
