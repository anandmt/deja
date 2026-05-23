import { join } from "path";
import { homedir } from "os";

const DEJA_DIR = join(homedir(), ".deja");

export const paths = {
  dejaDir: DEJA_DIR,
  db: join(DEJA_DIR, "memory.db"),
  dbBackup: join(DEJA_DIR, "memory.db.bak"),
  settings: join(DEJA_DIR, "settings.json"),
  workerSock: join(DEJA_DIR, "worker.sock"),
  workerPid: join(DEJA_DIR, "worker.pid"),
  workerLock: join(DEJA_DIR, "worker.lock"),
  pendingWal: join(DEJA_DIR, "pending.wal"),
  walLock: join(DEJA_DIR, "pending.wal.lock"),
  logsDir: join(DEJA_DIR, "logs"),
} as const;
