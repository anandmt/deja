import type { Database } from "bun:sqlite";
import type {
  HookPayload,
  BatchAnnotation,
  ClassifyInput,
  Settings,
} from "../types";
import type { Logger } from "../kernel/log";
import type { GrammarManager } from "../pipelines/extract/grammar";
import { classify } from "../pipelines/ingest/classify";
import { normalize } from "../pipelines/ingest/normalize";
import { extractHeuristic } from "../pipelines/extract/heuristic";
import { extractAst } from "../pipelines/extract/ast";
import { readFileSync, statSync } from "fs";

const MAX_AST_FILE_SIZE = 500 * 1024;
const MAX_TITLE_SYMBOLS = 5;

export class Pipeline {
  private recentCommands = new Set<string>();
  private seenWritePaths = new Set<string>();

  private db: Database;
  private stmtEnsureSession: ReturnType<Database["prepare"]>;
  private stmtIncrementStat: ReturnType<Database["prepare"]>;
  private stmtInsertObs: ReturnType<Database["prepare"]>;
  private stmtUpdateSessionEnd: ReturnType<Database["prepare"]>;
  private stmtUpdateSessionSummary: ReturnType<Database["prepare"]>;

  constructor(
    db: Database,
    private settings: Settings,
    private log: Logger,
    private grammarManager?: GrammarManager,
  ) {
    this.db = db;
    this.stmtEnsureSession = db.prepare(
      "INSERT OR IGNORE INTO sessions (id, project, started_at_epoch) VALUES (?, ?, ?)",
    );
    this.stmtIncrementStat = db.prepare(
      `INSERT INTO stats (project, metric, value) VALUES (?, ?, 1)
       ON CONFLICT(project, metric) DO UPDATE SET value = value + 1`,
    );
    this.stmtInsertObs = db.prepare(
      `INSERT INTO observations (session_id, project, significance, kind, title, content,
        facts, concepts, files_read, files_modified, raw_event, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtUpdateSessionEnd = db.prepare(
      "UPDATE sessions SET ended_at_epoch = ? WHERE id = ?",
    );
    this.stmtUpdateSessionSummary = db.prepare(
      "UPDATE sessions SET summary = ? WHERE id = ?",
    );
  }

  async processEvent(payload: HookPayload, batch: BatchAnnotation): Promise<void> {
    if (payload.type === "SessionStart") {
      this.stmtEnsureSession.run(payload.session_id, payload.cwd, Date.now());
      this.log("debug", "pipeline", `Session started: ${payload.session_id}`);
      return;
    }

    if (payload.type === "Stop") {
      this.stmtUpdateSessionEnd.run(Date.now(), payload.session_id);
      const summary = this.generateHeuristicSummary(payload.session_id);
      if (summary) {
        this.stmtUpdateSessionSummary.run(summary, payload.session_id);
      }
      this.log("debug", "pipeline", `Session stopped: ${payload.session_id}`);
      return;
    }

    const input: ClassifyInput = {
      payload,
      recentCommands: this.recentCommands,
      seenWritePaths: this.seenWritePaths,
      settings: this.settings,
      batch,
    };

    const classified = classify(input);

    this.trackState(payload);

    if (classified.significance === "skip") {
      this.stmtIncrementStat.run(payload.cwd, "events_skipped");
      return;
    }

    this.stmtEnsureSession.run(payload.session_id, payload.cwd, Date.now());

    const normalized = normalize(payload);
    const extracted = extractHeuristic(normalized, classified);

    if (
      this.settings.tiers.ast &&
      this.grammarManager &&
      (normalized.action === "edit" || normalized.action === "write")
    ) {
      const content = this.resolveFileContent(normalized);
      if (content && content.length <= MAX_AST_FILE_SIZE) {
        const filePath = normalized.files[0];
        if (filePath) {
          try {
            const symbols = await extractAst(content, filePath, this.grammarManager);
            if (symbols && symbols.length > 0) {
              extracted.facts = symbols;
              extracted.title = this.buildAstTitle(normalized.action, filePath, symbols);
            }
          } catch {
            // AST failed silently, heuristic extraction stands
          }
        }
      }
    }

    this.stmtInsertObs.run(
      payload.session_id,
      payload.cwd,
      classified.significance,
      extracted.kind,
      extracted.title,
      extracted.content,
      JSON.stringify(extracted.facts),
      JSON.stringify(extracted.concepts),
      JSON.stringify(extracted.files_read),
      JSON.stringify(extracted.files_modified),
      normalized.raw_event,
      Date.now(),
    );

    this.stmtIncrementStat.run(payload.cwd, "events_stored");
    this.log("debug", "pipeline", `Stored: ${extracted.title}`);
  }

  private generateHeuristicSummary(sessionId: string): string {
    const rows = this.db.prepare(
      `SELECT title, significance, kind FROM observations
       WHERE session_id = ?
       ORDER BY CASE significance
         WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1
       END DESC, created_at_epoch DESC
       LIMIT 15`,
    ).all(sessionId) as { title: string; significance: string; kind: string }[];

    if (rows.length === 0) return "";

    const important = rows
      .filter((r) => r.significance === "critical" || r.significance === "high")
      .map((r) => r.title);
    const other = rows
      .filter((r) => r.significance !== "critical" && r.significance !== "high")
      .map((r) => r.title);

    const parts: string[] = [];
    if (important.length > 0) parts.push("Worked on: " + important.join("; "));
    if (other.length > 0) parts.push("Also: " + other.join("; "));

    const summary = parts.join(". ") + ".";
    return summary.length > 500 ? summary.slice(0, 497) + "..." : summary;
  }

  private resolveFileContent(normalized: { action: string; files: string[]; raw_event: string }): string | null {
    if (normalized.action === "write") {
      try {
        const raw = JSON.parse(normalized.raw_event);
        return (raw.input?.content ?? null) as string | null;
      } catch {
        return null;
      }
    }

    const filePath = normalized.files[0];
    if (!filePath) return null;
    try {
      const stat = statSync(filePath);
      if (stat.size > MAX_AST_FILE_SIZE) return null;
      return readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  private buildAstTitle(action: string, filePath: string, symbols: string[]): string {
    const lastSlash = filePath.lastIndexOf("/");
    const filename = lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
    const prefix = action === "write" ? "Created" : "Edit";
    const shown = symbols.slice(0, MAX_TITLE_SYMBOLS);
    const suffix = symbols.length > MAX_TITLE_SYMBOLS
      ? ` + ${symbols.length - MAX_TITLE_SYMBOLS} more`
      : "";
    return `${prefix} ${filename} — ${shown.join(", ")}${suffix}`;
  }

  private trackState(payload: HookPayload): void {
    if (payload.type !== "PostToolUse") return;
    const tool = (payload as any).tool as string | undefined;

    if (tool === "Bash") {
      const cmd = ((payload as any).input?.command ?? "") as string;
      if (cmd) this.recentCommands.add(`${cmd}:${Date.now()}`);
    }

    if (tool === "Write") {
      const fp = ((payload as any).input?.file_path ?? "") as string;
      if (fp) this.seenWritePaths.add(fp);
    }
  }
}
