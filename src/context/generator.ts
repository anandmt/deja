import type { Database } from "bun:sqlite";
import type { Settings } from "../types";
import { getLastSessionSummary, getTopObservations, getCrossProjectInsights } from "./queries";
import { formatSessionSection, formatObservationsSection, formatCrossProjectSection, formatContextBlock } from "./format";

export function generateContext(
  db: Database,
  project: string,
  _sessionId: string,
  settings: Settings,
): string {
  const wrapperOverhead =
    `<system-reminder>\n# deja — project memory for ${project}\n\n`.length +
    `\nUse deja_search/deja_timeline/deja_observe MCP tools for deeper memory access.\n</system-reminder>`.length;
  const budget = Math.max(0, settings.context_budget - wrapperOverhead);
  let sessionBudget = Math.floor(budget * 0.4);
  let obsBudget = Math.floor(budget * 0.5);
  let crossBudget = Math.floor(budget * 0.1);

  const lastSession = getLastSessionSummary(db, project);
  const sessionSection = formatSessionSection(lastSession, sessionBudget);
  obsBudget += sessionBudget - sessionSection.length;

  const observations = getTopObservations(db, project, 10);
  const obsSection = formatObservationsSection(observations, obsBudget);
  crossBudget += obsBudget - obsSection.length;

  let crossSection = "";
  if (settings.cross_project) {
    const insights = getCrossProjectInsights(db, project, 2);
    crossSection = formatCrossProjectSection(insights, crossBudget);
  }

  const result = formatContextBlock(project, sessionSection, obsSection, crossSection);

  if (result) {
    db.prepare(
      `INSERT INTO stats (project, metric, value) VALUES (?, 'context_injections', 1)
       ON CONFLICT(project, metric) DO UPDATE SET value = value + 1`,
    ).run(project);
    db.prepare(
      `INSERT INTO stats (project, metric, value) VALUES (?, 'context_chars_total', ?)
       ON CONFLICT(project, metric) DO UPDATE SET value = value + ?`,
    ).run(project, result.length, result.length);
  }

  return result;
}
