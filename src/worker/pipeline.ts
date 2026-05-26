import type { Database } from "bun:sqlite";
import type {
  HookPayload,
  BatchAnnotation,
  ClassifyInput,
  Settings,
} from "../types";
import type { Logger } from "../kernel/log";
import { classify } from "../pipelines/ingest/classify";
import { normalize } from "../pipelines/ingest/normalize";
import { extractHeuristic } from "../pipelines/extract/heuristic";

export class Pipeline {
  private recentCommands = new Set<string>();
  private seenWritePaths = new Set<string>();

  private stmtEnsureSession: ReturnType<Database["prepare"]>;
  private stmtIncrementStat: ReturnType<Database["prepare"]>;
  private stmtInsertObs: ReturnType<Database["prepare"]>;

  constructor(
    db: Database,
    private settings: Settings,
    private log: Logger,
  ) {
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
  }

  processEvent(payload: HookPayload, batch: BatchAnnotation): void {
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
