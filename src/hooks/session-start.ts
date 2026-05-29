import { mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { paths } from "../paths";
import { openDb } from "../kernel/db";
import { runMigrations } from "../kernel/migrations";
import { readSettings } from "../kernel/settings";
import { generateContext } from "../context/generator";
import { mapPayload } from "./map-payload";
import { ensureWorker } from "./ensure-worker";
import { ensureDashboard } from "./ensure-dashboard";
import { trySendEvent } from "./send";

const raw = JSON.parse(await Bun.stdin.text());
const payload = mapPayload(raw);

mkdirSync(paths.dejaDir, { recursive: true });

function resolveScript(base: string, ...segments: string[]): string {
  const tsPath = resolve(base, ...segments) + ".ts";
  if (existsSync(tsPath)) return tsPath;
  const jsPath = resolve(base, ...segments) + ".js";
  if (existsSync(jsPath)) return jsPath;
  return tsPath;
}
const workerScript = resolveScript(import.meta.dir, "..", "worker", "main");
await ensureWorker({
  pidPath: paths.workerPid,
  sockPath: paths.workerSock,
  lockPath: paths.workerLock,
  workerScript,
});

const dashboardScript = resolveScript(import.meta.dir, "..", "dashboard", "serve");
ensureDashboard({
  pidPath: paths.dashboardPid,
  lockPath: paths.dashboardLock,
  dashboardScript,
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

const A = {
  r: "\x1b[0m",
  border: "\x1b[38;2;0;200;255m",
  title: "\x1b[1;38;2;0;255;255m",
  accent: "\x1b[38;2;0;200;255m",
  text: "\x1b[38;2;180;220;255m",
  url: "\x1b[38;2;0;255;128m",
  dim: "\x1b[38;2;80;120;150m",
};

function formatBanner(obsCount: number, sessionCount: number, lastActiveEpoch: number | null): string {
  type Line = { visible: string; colored: string };
  const lines: Line[] = [];

  if (obsCount > 0) {
    let visText = `${obsCount} memories :: ${sessionCount} session${sessionCount === 1 ? "" : "s"}`;
    let colText = `${A.text}${obsCount} memories ${A.dim}::${A.text} ${sessionCount} session${sessionCount === 1 ? "" : "s"}`;
    if (lastActiveEpoch) {
      const ago = Math.floor((Date.now() - lastActiveEpoch) / 1000);
      let timeAgo: string;
      if (ago < 60) timeAgo = "just now";
      else if (ago < 3600) timeAgo = `${Math.floor(ago / 60)}m ago`;
      else if (ago < 86400) timeAgo = `${Math.floor(ago / 3600)}h ago`;
      else timeAgo = `${Math.floor(ago / 86400)}d ago`;
      visText += ` :: ${timeAgo}`;
      colText += ` ${A.dim}::${A.text} ${timeAgo}`;
    }
    colText += A.r;
    lines.push({ visible: `> ${visText}`, colored: `${A.accent}>${A.r} ${colText}` });
  } else {
    lines.push({
      visible: "> First session -- observing & learning",
      colored: `${A.accent}>${A.r} ${A.text}First session -- observing & learning${A.r}`,
    });
  }
  lines.push({
    visible: "> Dashboard :: http://localhost:19533",
    colored: `${A.accent}>${A.r} ${A.text}Dashboard ${A.dim}::${A.r} ${A.url}http://localhost:19533${A.r}`,
  });

  const title = " d e j a ";
  const maxVis = Math.max(...lines.map(l => l.visible.length));
  const innerW = Math.max(maxVis + 4, title.length + 4);

  const b = A.border;
  const topFill = innerW - title.length - 1;
  const top = `${b}+-${A.r}${A.title}${title}${A.r}${b}${"-".repeat(topFill)}+${A.r}`;
  const bot = `${b}+${"-".repeat(innerW)}+${A.r}`;
  const blank = `${b}|${A.r}${" ".repeat(innerW)}${b}|${A.r}`;
  const body = lines.map(l => {
    const pad = innerW - l.visible.length - 2;
    return `${b}|${A.r}  ${l.colored}${" ".repeat(pad)}${b}|${A.r}`;
  }).join("\n");

  return `\n${top}\n${blank}\n${body}\n${blank}\n${bot}`;
}

if (context) {
  const output: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  };

  try {
    const db2 = openDb(paths.db);
    const row = db2.prepare(`
      SELECT
        (SELECT COUNT(*) FROM observations WHERE project = ?) as obs,
        (SELECT COUNT(*) FROM sessions WHERE project = ?) as sess,
        (SELECT MAX(ended_at_epoch) FROM sessions WHERE project = ? AND ended_at_epoch IS NOT NULL) as last_epoch
    `).get(payload.cwd, payload.cwd, payload.cwd) as { obs: number; sess: number; last_epoch: number | null } | null;
    db2.close();

    const obsCount = row?.obs ?? 0;
    const sessCount = row?.sess ?? 0;
    const rawEpoch = row?.last_epoch ?? null;
    const lastEpoch = rawEpoch ? (rawEpoch > 1e12 ? rawEpoch : rawEpoch * 1000) : null;
    output.systemMessage = formatBanner(obsCount, sessCount, lastEpoch);
  } catch {
    output.systemMessage = formatBanner(0, 0, null);
  }

  process.stdout.write(JSON.stringify(output));
}

await trySendEvent(
  paths.workerSock,
  { type: "event", hook: "SessionStart", payload },
  paths.pendingWal,
  paths.walLock,
);
