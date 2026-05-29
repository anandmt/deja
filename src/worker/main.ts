import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { paths } from "../paths";
import { openDb } from "../kernel/db";
import { runMigrations } from "../kernel/migrations";
import { readSettings } from "../kernel/settings";
import { createLogger, rotateOldLogs } from "../kernel/log";
import { drainWal } from "../kernel/wal";
import { SocketServer } from "../kernel/socket";
import { Debouncer } from "../pipelines/ingest/debounce";
import { Pipeline } from "./pipeline";
import { GrammarManager } from "../pipelines/extract/grammar";
import type { HookPayload, BatchAnnotation } from "../types";

async function main(): Promise<void> {
  mkdirSync(paths.dejaDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });

  const db = openDb(paths.db);
  runMigrations(db);
  const settings = readSettings(paths.settings);
  const log = createLogger(settings.log_level, paths.logsDir);

  log("info", "worker", `Starting deja worker (PID ${process.pid})`);

  rotateOldLogs(paths.logsDir, settings.log_max_days);

  const grammarManager = settings.tiers.ast
    ? new GrammarManager(join(homedir(), ".deja", "grammars"))
    : undefined;

  const pipeline = new Pipeline(db, settings, log, grammarManager);

  const walEvents = drainWal(paths.pendingWal, paths.walLock, log);
  if (walEvents.length > 0) {
    log("info", "worker", `Draining ${walEvents.length} events from WAL`);
    const defaultBatch: BatchAnnotation = {
      batch_size: 1,
      batch_index: 0,
      multi_file_edit: false,
      unique_files: [],
    };
    for (const eventJson of walEvents) {
      try {
        const payload = JSON.parse(eventJson) as HookPayload;
        await pipeline.processEvent(payload, defaultBatch);
      } catch (err) {
        log("error", "worker", `Failed to process WAL event: ${err}`);
      }
    }
  }

  const debouncer = new Debouncer(settings.debounce_ms, (payload, batch) => {
    pipeline.processEvent(payload, batch).catch((err) => {
      log("error", "worker", `Pipeline error: ${err}`);
    });
  });

  let idleTimer: ReturnType<typeof setTimeout>;
  const idleTimeoutMs = settings.worker_idle_timeout_minutes * 60 * 1000;

  function resetIdleTimer(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, idleTimeoutMs);
  }

  const socketPath = process.platform === "win32" ? undefined : paths.workerSock;

  const server = new SocketServer({
    socketPath: socketPath ?? `127.0.0.1:${settings.tcp_port}`,
    onMessage: (msg, respond) => {
      resetIdleTimer();

      if (msg.type === "event") {
        debouncer.push(msg.payload as HookPayload);
      } else if (msg.type === "request") {
        debouncer.push(msg.payload as HookPayload);
        debouncer.flush();
        respond({ type: "response", id: msg.id, status: "ok" });
      }
    },
    onError: (err) => {
      log("error", "socket", `Socket error: ${err.message}`);
    },
    log,
  });

  server.start();
  writeFileSync(paths.workerPid, String(process.pid));
  log("info", "worker", `Listening on ${socketPath ?? `TCP :${settings.tcp_port}`}`);
  resetIdleTimer();

  function shutdown(): void {
    log("info", "worker", "Shutting down (idle timeout or signal)");
    clearTimeout(idleTimer);
    debouncer.flush();
    debouncer.destroy();
    server.stop();

    try {
      unlinkSync(paths.workerSock);
    } catch {}
    try {
      unlinkSync(paths.workerPid);
    } catch {}

    log.flush();
    db.close();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
}

main().catch((err) => {
  console.error("Worker startup failed:", err);
  process.exit(1);
});
