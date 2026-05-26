import type { SessionSummaryRow, ObservationRow, CrossProjectRow, ProjectStats } from "./queries";

const DASHBOARD_PORT = 19533;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(epoch: number): string {
  const d = new Date(epoch);
  const month = MONTHS[d.getMonth()];
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 || 12;
  return `${month} ${day}, ${h12}:${minutes} ${ampm}`;
}

function truncateAtSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(".", maxLen);
  if (cut > maxLen * 0.5) return text.slice(0, cut + 1);
  const lineCut = text.lastIndexOf("\n", maxLen);
  if (lineCut > 0) return text.slice(0, lineCut);
  return text.slice(0, maxLen);
}

export function formatSessionSection(
  session: SessionSummaryRow | null,
  budget: number,
): string {
  if (!session || !session.summary) return "";

  const dateRange = session.ended_at_epoch
    ? `${formatDate(session.started_at_epoch)} — ${formatDate(session.ended_at_epoch)}`
    : formatDate(session.started_at_epoch);

  const header = `## Last session (${dateRange})\n`;
  const remaining = budget - header.length;
  if (remaining <= 0) return "";

  const summary = truncateAtSentence(session.summary, remaining - 1);
  const result = header + summary + "\n";
  return result.slice(0, budget);
}

export function formatObservationsSection(
  observations: ObservationRow[],
  budget: number,
): string {
  if (observations.length === 0) return "";

  const header = "## Key observations (most recent, highest significance first)\n";
  let result = header;
  if (result.length >= budget) return "";

  for (const obs of observations) {
    const line = `- [#${obs.id}] ${obs.significance.toUpperCase()}: ${obs.title}\n`;
    if (result.length + line.length > budget) break;
    result += line;
  }

  return result.length > header.length ? result : "";
}

function projectName(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}

export function formatCrossProjectSection(
  insights: CrossProjectRow[],
  budget: number,
): string {
  if (insights.length === 0) return "";

  const header = "## Cross-project\n";
  let result = header;
  if (result.length >= budget) return "";

  for (const ins of insights) {
    const name = projectName(ins.project);
    const line = `- [#${ins.id}/${name}] ${ins.significance.toUpperCase()}: ${ins.title}\n`;
    if (result.length + line.length > budget) break;
    result += line;
  }

  return result.length > header.length ? result : "";
}

export function formatContextBlock(
  project: string,
  sessionSection: string,
  observationsSection: string,
  crossProjectSection: string,
  stats?: ProjectStats,
): string {
  const body = sessionSection + observationsSection + crossProjectSection;

  if (!stats) {
    if (!body.trim()) return "";
    const footer = "\nUse deja_search/deja_timeline/deja_observe MCP tools for deeper memory access.\n";
    return `<system-reminder>\n# deja — project memory for ${project}\n\n${body}${footer}</system-reminder>`;
  }

  const statusLine = stats.observations === 0
    ? "First session — capturing observations for next time."
    : `${stats.observations} observations across ${stats.sessions} sessions`;
  const dashboard = `Dashboard: http://localhost:${DASHBOARD_PORT}`;

  if (!body.trim()) {
    return `<system-reminder>\n# deja — project memory for ${project}\n${statusLine} | ${dashboard}\n</system-reminder>`;
  }

  const footer = "\nUse deja_search/deja_timeline/deja_observe MCP tools for deeper memory access.\n";
  return `<system-reminder>\n# deja — project memory for ${project}\n${statusLine} | ${dashboard}\n\n${body}${footer}</system-reminder>`;
}
