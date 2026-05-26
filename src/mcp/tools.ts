import type { Database } from "bun:sqlite";
import { searchFts } from "../pipelines/search/fts";
import type { Significance, ObservationKind } from "../types";

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface SearchInput {
  query: string;
  project?: string;
  significance?: Significance;
  kind?: ObservationKind;
  limit?: number;
}

export function handleSearch(db: Database, input: SearchInput): ToolResult {
  const { results, total_count } = searchFts(db, input.query, {
    project: input.project,
    significance: input.significance,
    kind: input.kind,
    limit: input.limit,
  });
  return {
    content: [{ type: "text", text: JSON.stringify({ results, total_count }) }],
  };
}

interface TimelineInput {
  anchor: number;
  depth_before?: number;
  depth_after?: number;
}

export function handleTimeline(db: Database, input: TimelineInput): ToolResult {
  const depthBefore = input.depth_before ?? 5;
  const depthAfter = input.depth_after ?? 5;

  const anchorRow = db.prepare(
    "SELECT session_id, created_at_epoch FROM observations WHERE id = ?",
  ).get(input.anchor) as { session_id: string; created_at_epoch: number } | null;

  if (!anchorRow) {
    return { content: [{ type: "text", text: `Observation #${input.anchor} not found` }], isError: true };
  }

  const before = db.prepare(
    `SELECT id, title, significance, kind, created_at_epoch
     FROM observations WHERE session_id = ? AND created_at_epoch < ?
     ORDER BY created_at_epoch DESC LIMIT ?`,
  ).all(anchorRow.session_id, anchorRow.created_at_epoch, depthBefore) as any[];

  const anchor = db.prepare(
    `SELECT id, title, significance, kind, created_at_epoch
     FROM observations WHERE id = ?`,
  ).get(input.anchor) as any;

  const after = db.prepare(
    `SELECT id, title, significance, kind, created_at_epoch
     FROM observations WHERE session_id = ? AND created_at_epoch > ?
     ORDER BY created_at_epoch ASC LIMIT ?`,
  ).all(anchorRow.session_id, anchorRow.created_at_epoch, depthAfter) as any[];

  const timeline = [...before.reverse(), anchor, ...after];
  return { content: [{ type: "text", text: JSON.stringify(timeline) }] };
}

interface ObserveInput {
  ids: number[];
}

const MAX_OBSERVE_IDS = 10;

export function handleObserve(db: Database, input: ObserveInput): ToolResult {
  if (input.ids.length === 0) {
    return { content: [{ type: "text", text: "ids array must not be empty" }], isError: true };
  }
  if (input.ids.length > MAX_OBSERVE_IDS) {
    return { content: [{ type: "text", text: `Max ${MAX_OBSERVE_IDS} IDs per request (got ${input.ids.length})` }], isError: true };
  }

  const placeholders = input.ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, session_id, project, significance, kind, title, content, facts, concepts, files_read, files_modified, created_at_epoch
     FROM observations WHERE id IN (${placeholders})
     ORDER BY created_at_epoch`,
  ).all(...input.ids);

  return { content: [{ type: "text", text: JSON.stringify(rows) }] };
}
