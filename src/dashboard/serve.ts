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

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function getParam(url: URL, key: string, fallback: string): string {
  return url.searchParams.get(key) ?? fallback;
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

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`deja dashboard running at http://localhost:${port}`);
