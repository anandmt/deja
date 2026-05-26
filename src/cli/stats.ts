import type { Database } from "bun:sqlite";

export function cliStats(db: Database, project: string): string {
  const obsCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM observations WHERE project = ?",
  ).get(project) as { cnt: number }).cnt;

  const sessionCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM sessions WHERE project = ?",
  ).get(project) as { cnt: number }).cnt;

  const sigBreakdown = db.prepare(
    `SELECT significance, COUNT(*) as cnt FROM observations
     WHERE project = ? GROUP BY significance ORDER BY
     CASE significance WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END`,
  ).all(project) as { significance: string; cnt: number }[];

  const statsRows = db.prepare(
    "SELECT metric, value FROM stats WHERE project = ?",
  ).all(project) as { metric: string; value: number }[];

  const lines: string[] = [
    `Project: ${project}`,
    `Sessions: ${sessionCount}`,
    `Observations: ${obsCount}`,
  ];

  if (sigBreakdown.length > 0) {
    lines.push("  By significance:");
    for (const row of sigBreakdown) {
      lines.push(`    ${row.significance}: ${row.cnt}`);
    }
  }

  if (statsRows.length > 0) {
    lines.push("Stats:");
    for (const row of statsRows) {
      lines.push(`  ${row.metric}: ${row.value}`);
    }
  }

  return lines.join("\n");
}
