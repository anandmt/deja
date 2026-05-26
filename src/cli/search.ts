import type { Database } from "bun:sqlite";
import { searchFts } from "../pipelines/search/fts";
import type { Significance } from "../types";

interface SearchOptions {
  project?: string;
  significance?: Significance;
  kind?: string;
  limit?: number;
}

export function cliSearch(db: Database, query: string, options: SearchOptions): string {
  const { results, total_count } = searchFts(db, query, {
    project: options.project,
    significance: options.significance,
    kind: options.kind,
    limit: options.limit,
  });

  if (results.length === 0) {
    return `No results for "${query}"`;
  }

  const lines: string[] = [];
  for (const r of results) {
    const date = new Date(r.created_at_epoch).toISOString().slice(0, 10);
    lines.push(`  #${r.id}  [${r.significance.toUpperCase()}] ${r.title}  (${r.kind}, ${date})`);
  }

  const countLabel = results.length < total_count
    ? `${results.length} of ${total_count} results`
    : `${total_count} result${total_count === 1 ? "" : "s"}`;

  return `${countLabel} for "${query}":\n${lines.join("\n")}`;
}
