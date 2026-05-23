import type { Database } from "bun:sqlite";
import type { Significance } from "../../types";

export interface SearchResult {
  id: number;
  title: string;
  significance: string;
  kind: string;
  created_at_epoch: number;
}

export interface SearchOptions {
  project?: string;
  significance?: Significance;
  kind?: string;
  limit?: number;
}

export function searchFts(
  db: Database,
  query: string,
  options: SearchOptions = {},
): { results: SearchResult[]; total_count: number } {
  if (!query.trim()) return { results: [], total_count: 0 };

  const limit = Math.min(options.limit ?? 20, 50);
  const safeQuery = `"${query.replace(/"/g, '""')}"`;
  const conditions: string[] = [];
  const params: (string | number)[] = [safeQuery];

  if (options.project) {
    conditions.push("o.project = ?");
    params.push(options.project);
  }
  if (options.significance) {
    conditions.push("o.significance = ?");
    params.push(options.significance);
  }
  if (options.kind) {
    conditions.push("o.kind = ?");
    params.push(options.kind);
  }

  const whereExtra = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM observations_fts f
    JOIN observations o ON o.id = f.rowid
    WHERE observations_fts MATCH ?
    ${whereExtra}
  `).get(...params) as { cnt: number };

  const results = db.prepare(`
    SELECT o.id, o.title, o.significance, o.kind, o.created_at_epoch
    FROM observations_fts f
    JOIN observations o ON o.id = f.rowid
    WHERE observations_fts MATCH ?
    ${whereExtra}
    ORDER BY f.rank
    LIMIT ?
  `).all(...params, limit) as SearchResult[];

  return { results, total_count: countRow.cnt };
}
