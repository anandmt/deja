import { mkdirSync } from "fs";
import { resolve } from "path";
import { paths } from "../paths";
import { openDb } from "../kernel/db";
import { runMigrations } from "../kernel/migrations";
import { readSettings } from "../kernel/settings";
import { generateContext } from "../context/generator";
import { mapPayload } from "./map-payload";
import { ensureWorker } from "./ensure-worker";
import { trySendEvent } from "./send";

const raw = JSON.parse(await Bun.stdin.text());
const payload = mapPayload(raw);

mkdirSync(paths.dejaDir, { recursive: true });

const workerScript = resolve(import.meta.dir, "..", "worker", "main.ts");
await ensureWorker({
  pidPath: paths.workerPid,
  sockPath: paths.workerSock,
  lockPath: paths.workerLock,
  workerScript,
});

let context = "";
try {
  const db = openDb(paths.db);
  runMigrations(db);
  const settings = readSettings(paths.settings);
  context = generateContext(db, payload.cwd, payload.session_id, settings);
  db.close();
} catch {
  // DB not ready yet (first ever session) — no context to inject
}

if (context) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

await trySendEvent(
  paths.workerSock,
  { type: "event", hook: "SessionStart", payload },
  paths.pendingWal,
  paths.walLock,
);
