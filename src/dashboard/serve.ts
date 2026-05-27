import { openDb } from "../kernel/db";
import { runMigrations } from "../kernel/migrations";
import { getOverview, getRecentObservations, getSessions, getProjects } from "./api";
import { join, resolve } from "path";
import { homedir } from "os";

const dbPath = process.env.DEJA_DB_PATH ?? join(homedir(), ".deja", "memory.db");
const port = parseInt(process.env.DEJA_DASHBOARD_PORT ?? "19533", 10);
const htmlPath = resolve(import.meta.dir, "index.html");

const db = openDb(dbPath);
runMigrations(db);

const encoder = new TextEncoder();
const sseClients = new Set<ReadableStreamDefaultController>();
const sseTimers = new Map<ReadableStreamDefaultController, Timer>();

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function getParam(url: URL, key: string, fallback: string): string {
  return url.searchParams.get(key) ?? fallback;
}

function removeClient(controller: ReadableStreamDefaultController) {
  sseClients.delete(controller);
  const timer = sseTimers.get(controller);
  if (timer) { clearInterval(timer); sseTimers.delete(controller); }
}

function notifyClients() {
  const msg = encoder.encode(`data: refresh\n\n`);
  for (const controller of sseClients) {
    try {
      controller.enqueue(msg);
    } catch {
      removeClient(controller);
    }
  }
}

Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" || path === "/index.html") {
      return new Response(Bun.file(htmlPath), {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (path === "/api/events") {
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(controller) {
          ctrl = controller;
          sseClients.add(controller);
          controller.enqueue(encoder.encode(": connected\n\n"));
          const timer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": keep-alive\n\n"));
            } catch {
              removeClient(controller);
            }
          }, 5000);
          sseTimers.set(controller, timer);
        },
        cancel() {
          removeClient(ctrl);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (path === "/api/notify" && req.method === "POST") {
      notifyClients();
      return json({ ok: true });
    }

    if (path === "/api/projects") {
      return json(getProjects(db));
    }

    if (path === "/api/overview") {
      const project = getParam(url, "project", process.cwd());
      return json(getOverview(db, project));
    }

    if (path === "/api/observations") {
      const project = getParam(url, "project", process.cwd());
      const limit = parseInt(getParam(url, "limit", "50"), 10);
      return json(getRecentObservations(db, project, Math.min(limit, 200)));
    }

    if (path === "/api/sessions") {
      const project = getParam(url, "project", process.cwd());
      const limit = parseInt(getParam(url, "limit", "20"), 10);
      return json(getSessions(db, project, Math.min(limit, 100)));
    }

    if (path === "/favicon.ico") {
      return new Response(Bun.file(resolve(import.meta.dir, "favicon.png")), {
        headers: { "Content-Type": "image/png" },
      });
    }

    if (path === "/logo.png" || path === "/favicon.png") {
      return new Response(Bun.file(resolve(import.meta.dir, path.slice(1))), {
        headers: { "Content-Type": "image/png" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`deja dashboard running at http://localhost:${port}`);
