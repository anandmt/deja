# Context Injection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the context generator stub with real SessionStart context injection — query the DB for last session summary, high-significance observations, and cross-project insights, then format them within a configurable character budget.

**Architecture:** The generator reads SQLite directly (not through the worker) to stay under 200ms. It fills a character budget (default 8000 chars) in priority order: last session summary (40%), high-significance observations (50%), cross-project insights (10%). Unused budget from earlier sections rolls to the next. The output is a `<system-reminder>` block that Claude Code injects into the agent's context. Stats counters are incremented via upsert.

**Tech Stack:** Bun, TypeScript, SQLite (bun:sqlite), FTS5

---

## File Structure

```
src/context/
├── generator.ts        # Modify: replace stub with real logic — orchestrates the 3 sections
├── queries.ts          # Create: DB queries (last session, top observations, cross-project)
└── format.ts           # Create: formats observations into system-reminder text

tests/context/
├── generator.test.ts   # Modify: replace stub test with integration tests
├── queries.test.ts     # Create: unit tests for each query function
└── format.test.ts      # Create: unit tests for formatting functions
```

---

## Chunk 1: Query Functions

### Task 1: Last Session Summary Query

**Files:**
- Create: `src/context/queries.ts`
- Create: `tests/context/queries.test.ts`

- [ ] **Step 1: Write failing tests for getLastSessionSummary**

```typescript
// tests/context/queries.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../src/test/helpers";
import { runMigrations } from "../../src/kernel/migrations";
import {
  getLastSessionSummary,
  getTopObservations,
  getCrossProjectInsights,
} from "../../src/context/queries";

function insertSession(db: Database, id: string, project: string, summary: string | null, startedAt: number = Date.now()): void {
  db.prepare("INSERT INTO sessions (id, project, started_at_epoch, ended_at_epoch, summary) VALUES (?, ?, ?, ?, ?)").run(id, project, startedAt, startedAt + 3600000, summary);
}

function insertObs(db: Database, opts: {
  sessionId: string; project: string; significance: string; kind: string;
  title: string; content: string; concepts?: string[]; createdAt?: number;
}): number {
  const stmt = db.prepare(
    `INSERT INTO observations (session_id, project, significance, kind, title, content, facts, concepts, files_read, files_modified, raw_event, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, '[]', '[]', '{}', ?)`
  );
  stmt.run(
    opts.sessionId, opts.project, opts.significance, opts.kind,
    opts.title, opts.content,
    JSON.stringify(opts.concepts ?? []),
    opts.createdAt ?? Date.now(),
  );
  return db.query("SELECT last_insert_rowid() as id").get() as any;
}

describe("getLastSessionSummary", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns summary of most recent session for project", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", "First session summary", 1000);
    insertSession(db, "s2", "/project", "Second session summary", 2000);

    const result = getLastSessionSummary(db, "/project");
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Second session summary");
    expect(result!.started_at_epoch).toBe(2000);
  });

  test("returns null when no sessions exist", () => {
    db = tmpDb();
    runMigrations(db);
    const result = getLastSessionSummary(db, "/project");
    expect(result).toBeNull();
  });

  test("returns null when latest session has no summary", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", null, 1000);
    const result = getLastSessionSummary(db, "/project");
    expect(result).toBeNull();
  });

  test("ignores sessions from other projects", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/other", "Other project session", 2000);
    const result = getLastSessionSummary(db, "/project");
    expect(result).toBeNull();
  });
});

describe("getTopObservations", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns observations sorted by significance then recency", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", null);
    insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: "Medium edit", content: "c1", createdAt: 3000 });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "critical", kind: "decision", title: "Critical decision", content: "c2", createdAt: 1000 });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "file_write", title: "High write", content: "c3", createdAt: 2000 });

    const results = getTopObservations(db, "/project", 10);
    expect(results.length).toBe(3);
    expect(results[0].significance).toBe("critical");
    expect(results[1].significance).toBe("high");
    expect(results[2].significance).toBe("medium");
  });

  test("respects limit parameter", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", null);
    for (let i = 0; i < 15; i++) {
      insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: `Edit ${i}`, content: `c${i}`, createdAt: i });
    }
    const results = getTopObservations(db, "/project", 5);
    expect(results.length).toBe(5);
  });

  test("excludes low significance observations", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", null);
    insertObs(db, { sessionId: "s1", project: "/project", significance: "low", kind: "file_read", title: "Low read", content: "c1" });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "medium", kind: "file_edit", title: "Medium edit", content: "c2" });

    const results = getTopObservations(db, "/project", 10);
    expect(results.length).toBe(1);
    expect(results[0].significance).toBe("medium");
  });

  test("returns empty array when no observations", () => {
    db = tmpDb();
    runMigrations(db);
    const results = getTopObservations(db, "/project", 10);
    expect(results).toEqual([]);
  });
});

describe("getCrossProjectInsights", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("finds observations from other projects with 2+ shared concepts", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a", null);
    insertSession(db, "s2", "/project-b", null);

    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Local obs", content: "c1", concepts: ["rate-limiting", "api", "caching"] });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "critical", kind: "decision", title: "Cross insight", content: "c2", concepts: ["rate-limiting", "api", "throttle"] });

    const results = getCrossProjectInsights(db, "/project-a", 2);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Cross insight");
    expect(results[0].project).toBe("/project-b");
    expect(results[0].shared_concepts).toBeGreaterThanOrEqual(2);
  });

  test("requires at least 2 shared concepts", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a", null);
    insertSession(db, "s2", "/project-b", null);

    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Local obs", content: "c1", concepts: ["rate-limiting", "api"] });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "high", kind: "file_edit", title: "Only 1 shared", content: "c2", concepts: ["rate-limiting", "unrelated"] });

    const results = getCrossProjectInsights(db, "/project-a", 2);
    expect(results.length).toBe(0);
  });

  test("only returns high/critical observations from other projects", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a", null);
    insertSession(db, "s2", "/project-b", null);

    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Local", content: "c1", concepts: ["api", "caching"] });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "medium", kind: "file_edit", title: "Medium cross", content: "c2", concepts: ["api", "caching"] });

    const results = getCrossProjectInsights(db, "/project-a", 2);
    expect(results.length).toBe(0);
  });

  test("returns empty when no other projects exist", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a", null);
    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Only local", content: "c1", concepts: ["api", "caching"] });

    const results = getCrossProjectInsights(db, "/project-a", 2);
    expect(results).toEqual([]);
  });

  test("respects max limit", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a", null);
    insertSession(db, "s2", "/project-b", null);

    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Local", content: "c1", concepts: ["api", "caching", "auth"] });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "critical", kind: "decision", title: "Cross 1", content: "c2", concepts: ["api", "caching"], createdAt: 2000 });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "high", kind: "file_edit", title: "Cross 2", content: "c3", concepts: ["api", "auth"], createdAt: 3000 });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "high", kind: "file_edit", title: "Cross 3", content: "c4", concepts: ["caching", "auth"], createdAt: 4000 });

    const results = getCrossProjectInsights(db, "/project-a", 2);
    expect(results.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/context/queries.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement query functions**

```typescript
// src/context/queries.ts
import type { Database } from "bun:sqlite";

export interface SessionSummaryRow {
  id: string;
  summary: string;
  started_at_epoch: number;
  ended_at_epoch: number | null;
}

export interface ObservationRow {
  id: number;
  significance: string;
  kind: string;
  title: string;
  content: string;
  facts: string;
  concepts: string;
  created_at_epoch: number;
}

export interface CrossProjectRow extends ObservationRow {
  project: string;
  shared_concepts: number;
}

const SIGNIFICANCE_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function getLastSessionSummary(
  db: Database,
  project: string,
): SessionSummaryRow | null {
  const row = db.prepare(`
    SELECT id, summary, started_at_epoch, ended_at_epoch
    FROM sessions
    WHERE project = ? AND summary IS NOT NULL AND summary != ''
    ORDER BY started_at_epoch DESC
    LIMIT 1
  `).get(project) as SessionSummaryRow | null;
  return row ?? null;
}

export function getTopObservations(
  db: Database,
  project: string,
  limit: number,
): ObservationRow[] {
  return db.prepare(`
    SELECT id, significance, kind, title, content, facts, concepts, created_at_epoch
    FROM observations
    WHERE project = ? AND significance IN ('medium', 'high', 'critical')
    ORDER BY
      CASE significance
        WHEN 'critical' THEN 4
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        ELSE 1
      END DESC,
      created_at_epoch DESC
    LIMIT ?
  `).all(project, limit) as ObservationRow[];
}

export function getCrossProjectInsights(
  db: Database,
  currentProject: string,
  maxInsights: number,
): CrossProjectRow[] {
  // Step 1: Collect current project's concept vocabulary
  const localRows = db.prepare(`
    SELECT concepts FROM observations
    WHERE project = ? AND significance IN ('high', 'critical')
    ORDER BY created_at_epoch DESC LIMIT 50
  `).all(currentProject) as { concepts: string }[];

  const localConcepts = new Set<string>();
  for (const row of localRows) {
    try {
      const arr = JSON.parse(row.concepts) as string[];
      for (const c of arr) localConcepts.add(c);
    } catch {}
  }

  if (localConcepts.size === 0) return [];

  // Step 2: Find candidates from other projects
  const candidates = db.prepare(`
    SELECT id, significance, kind, title, content, facts, concepts, created_at_epoch, project
    FROM observations
    WHERE project != ? AND significance IN ('high', 'critical')
    ORDER BY created_at_epoch DESC LIMIT 200
  `).all(currentProject) as (ObservationRow & { project: string })[];

  const matches: CrossProjectRow[] = [];
  for (const candidate of candidates) {
    try {
      const arr = JSON.parse(candidate.concepts) as string[];
      let shared = 0;
      for (const c of arr) {
        if (localConcepts.has(c)) shared++;
      }
      if (shared >= 2) {
        matches.push({ ...candidate, shared_concepts: shared });
      }
    } catch {}
  }

  // Rank by shared concepts desc, then recency
  matches.sort((a, b) =>
    b.shared_concepts - a.shared_concepts || b.created_at_epoch - a.created_at_epoch
  );

  return matches.slice(0, maxInsights);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/context/queries.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/context/queries.ts tests/context/queries.test.ts
git commit -m "feat: add context injection query functions (session, observations, cross-project)"
```

---

## Chunk 2: Formatting Functions

### Task 2: Context Formatter

**Files:**
- Create: `src/context/format.ts`
- Create: `tests/context/format.test.ts`

Formats query results into the `<system-reminder>` block with budget enforcement.

- [ ] **Step 1: Write failing tests for formatContext**

```typescript
// tests/context/format.test.ts
import { describe, test, expect } from "bun:test";
import {
  formatSessionSection,
  formatObservationsSection,
  formatCrossProjectSection,
  formatContextBlock,
} from "../../src/context/format";
import type { SessionSummaryRow, ObservationRow, CrossProjectRow } from "../../src/context/queries";

describe("formatSessionSection", () => {
  test("formats session summary with date range", () => {
    const session: SessionSummaryRow = {
      id: "s1",
      summary: "Implemented user auth with JWT tokens",
      started_at_epoch: new Date("2026-05-20T22:15:00").getTime(),
      ended_at_epoch: new Date("2026-05-20T23:42:00").getTime(),
    };
    const result = formatSessionSection(session, 3200);
    expect(result).toContain("## Last session");
    expect(result).toContain("Implemented user auth with JWT tokens");
  });

  test("truncates summary to budget", () => {
    const longSummary = "A".repeat(5000);
    const session: SessionSummaryRow = {
      id: "s1",
      summary: longSummary,
      started_at_epoch: Date.now(),
      ended_at_epoch: null,
    };
    const result = formatSessionSection(session, 200);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  test("returns empty string for null session", () => {
    const result = formatSessionSection(null, 3200);
    expect(result).toBe("");
  });
});

describe("formatObservationsSection", () => {
  test("formats observations as bullet list", () => {
    const obs: ObservationRow[] = [
      { id: 247, significance: "critical", kind: "decision", title: "Chose micro-kernel architecture", content: "c", facts: "[]", concepts: "[]", created_at_epoch: Date.now() },
      { id: 245, significance: "high", kind: "file_write", title: "Added SQLite schema with FTS5", content: "c", facts: "[]", concepts: "[]", created_at_epoch: Date.now() },
    ];
    const result = formatObservationsSection(obs, 4000);
    expect(result).toContain("## Key observations");
    expect(result).toContain("[#247] CRITICAL:");
    expect(result).toContain("[#245] HIGH:");
  });

  test("truncates to budget", () => {
    const obs: ObservationRow[] = [];
    for (let i = 0; i < 20; i++) {
      obs.push({ id: i, significance: "medium", kind: "file_edit", title: `Edit file ${i} with a fairly long title to fill budget`, content: "c", facts: "[]", concepts: "[]", created_at_epoch: Date.now() });
    }
    const result = formatObservationsSection(obs, 300);
    expect(result.length).toBeLessThanOrEqual(300);
  });

  test("returns empty string for empty observations", () => {
    const result = formatObservationsSection([], 4000);
    expect(result).toBe("");
  });
});

describe("formatCrossProjectSection", () => {
  test("formats cross-project observations with project name", () => {
    const insights: CrossProjectRow[] = [
      { id: 89, significance: "critical", kind: "decision", title: "IBKR rate limit is 50/s", content: "c", facts: "[]", concepts: "[]", created_at_epoch: Date.now(), project: "/Users/alice/trading-bot", shared_concepts: 3 },
    ];
    const result = formatCrossProjectSection(insights, 800);
    expect(result).toContain("## Cross-project");
    expect(result).toContain("[#89/trading-bot]");
  });

  test("extracts directory name from project path", () => {
    const insights: CrossProjectRow[] = [
      { id: 1, significance: "high", kind: "file_edit", title: "Found bug", content: "c", facts: "[]", concepts: "[]", created_at_epoch: Date.now(), project: "/Users/alice/projects/my-app", shared_concepts: 2 },
    ];
    const result = formatCrossProjectSection(insights, 800);
    expect(result).toContain("[#1/my-app]");
  });

  test("returns empty string for no insights", () => {
    const result = formatCrossProjectSection([], 800);
    expect(result).toBe("");
  });
});

describe("formatContextBlock", () => {
  test("wraps content in system-reminder tags with header and footer", () => {
    const result = formatContextBlock("/Users/alice/my-project", "## Last session\nDid things\n", "", "");
    expect(result).toContain("<system-reminder>");
    expect(result).toContain("# deja — project memory for /Users/alice/my-project");
    expect(result).toContain("## Last session");
    expect(result).toContain("Use deja_search/deja_timeline/deja_observe MCP tools");
    expect(result).toContain("</system-reminder>");
  });

  test("returns empty string when all sections are empty", () => {
    const result = formatContextBlock("/project", "", "", "");
    expect(result).toBe("");
  });

  test("includes all non-empty sections", () => {
    const result = formatContextBlock("/project", "session stuff\n", "obs stuff\n", "cross stuff\n");
    expect(result).toContain("session stuff");
    expect(result).toContain("obs stuff");
    expect(result).toContain("cross stuff");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/context/format.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement format functions**

```typescript
// src/context/format.ts
import type { SessionSummaryRow, ObservationRow, CrossProjectRow } from "./queries";

function formatDate(epoch: number): string {
  const d = new Date(epoch);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 || 12;
  return `${month} ${day}, ${h12}:${minutes} ${ampm}`;
}

function truncateAtSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(".", maxLen);
  if (cut > maxLen * 0.5) return text.slice(0, cut + 1);
  const lineCut = text.lastIndexOf("\n", maxLen);
  if (lineCut > 0) return text.slice(0, lineCut);
  return text.slice(0, maxLen);
}

export function formatSessionSection(
  session: SessionSummaryRow | null,
  budget: number,
): string {
  if (!session || !session.summary) return "";

  const dateRange = session.ended_at_epoch
    ? `${formatDate(session.started_at_epoch)} — ${formatDate(session.ended_at_epoch)}`
    : formatDate(session.started_at_epoch);

  const header = `## Last session (${dateRange})\n`;
  const remaining = budget - header.length;
  if (remaining <= 0) return "";

  const summary = truncateAtSentence(session.summary, remaining);
  const result = header + summary + "\n";
  return result.slice(0, budget);
}

export function formatObservationsSection(
  observations: ObservationRow[],
  budget: number,
): string {
  if (observations.length === 0) return "";

  const header = "## Key observations (most recent, highest significance first)\n";
  let result = header;
  if (result.length >= budget) return "";

  for (const obs of observations) {
    const line = `- [#${obs.id}] ${obs.significance.toUpperCase()}: ${obs.title}\n`;
    if (result.length + line.length > budget) break;
    result += line;
  }

  return result.length > header.length ? result : "";
}

function projectName(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}

export function formatCrossProjectSection(
  insights: CrossProjectRow[],
  budget: number,
): string {
  if (insights.length === 0) return "";

  const header = "## Cross-project\n";
  let result = header;
  if (result.length >= budget) return "";

  for (const ins of insights) {
    const name = projectName(ins.project);
    const line = `- [#${ins.id}/${name}] ${ins.significance.toUpperCase()}: ${ins.title}\n`;
    if (result.length + line.length > budget) break;
    result += line;
  }

  return result.length > header.length ? result : "";
}

export function formatContextBlock(
  project: string,
  sessionSection: string,
  observationsSection: string,
  crossProjectSection: string,
): string {
  const body = sessionSection + observationsSection + crossProjectSection;
  if (!body.trim()) return "";

  const footer = "\nUse deja_search/deja_timeline/deja_observe MCP tools for deeper memory access.\n";

  return `<system-reminder>\n# deja — project memory for ${project}\n\n${body}${footer}</system-reminder>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/context/format.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/context/format.ts tests/context/format.test.ts
git commit -m "feat: add context formatting with budget enforcement"
```

---

## Chunk 3: Generator Integration

### Task 3: Wire Generator with Queries + Formatting + Stats

**Files:**
- Modify: `src/context/generator.ts` (replace stub)
- Modify: `tests/context/generator.test.ts` (replace stub test with integration tests)

- [ ] **Step 1: Write failing tests for the real generator**

```typescript
// tests/context/generator.test.ts — replace entire file
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpDb, cleanupDb } from "../../src/test/helpers";
import { runMigrations } from "../../src/kernel/migrations";
import { generateContext } from "../../src/context/generator";
import { DEFAULT_SETTINGS } from "../../src/kernel/settings";
import type { Settings } from "../../src/types";

function insertSession(db: Database, id: string, project: string, summary: string | null, startedAt: number = Date.now()): void {
  db.prepare("INSERT INTO sessions (id, project, started_at_epoch, ended_at_epoch, summary) VALUES (?, ?, ?, ?, ?)").run(id, project, startedAt, startedAt + 3600000, summary);
}

function insertObs(db: Database, opts: {
  sessionId: string; project: string; significance: string; kind: string;
  title: string; content?: string; concepts?: string[]; createdAt?: number;
}): void {
  db.prepare(
    `INSERT INTO observations (session_id, project, significance, kind, title, content, facts, concepts, files_read, files_modified, raw_event, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, '[]', '[]', '{}', ?)`
  ).run(
    opts.sessionId, opts.project, opts.significance, opts.kind,
    opts.title, opts.content ?? "content",
    JSON.stringify(opts.concepts ?? []),
    opts.createdAt ?? Date.now(),
  );
}

describe("generateContext", () => {
  let db: Database;
  afterEach(() => { if (db) cleanupDb(db); });

  test("returns empty string on empty database", () => {
    db = tmpDb();
    runMigrations(db);
    const result = generateContext(db, "/project", "s1", DEFAULT_SETTINGS);
    expect(result).toBe("");
  });

  test("includes last session summary", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s-old", "/project", "Built the auth system", 1000);

    const result = generateContext(db, "/project", "s-new", DEFAULT_SETTINGS);
    expect(result).toContain("## Last session");
    expect(result).toContain("Built the auth system");
    expect(result).toContain("<system-reminder>");
  });

  test("includes high-significance observations", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", null);
    insertObs(db, { sessionId: "s1", project: "/project", significance: "critical", kind: "decision", title: "Chose Redis for caching" });
    insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "file_write", title: "Created auth middleware" });

    const result = generateContext(db, "/project", "s-new", DEFAULT_SETTINGS);
    expect(result).toContain("CRITICAL: Chose Redis for caching");
    expect(result).toContain("HIGH: Created auth middleware");
  });

  test("includes cross-project insights when enabled", () => {
    db = tmpDb();
    runMigrations(db);
    const settings: Settings = { ...DEFAULT_SETTINGS, cross_project: true };
    insertSession(db, "s1", "/project-a", null);
    insertSession(db, "s2", "/project-b", null);
    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Local A", concepts: ["api", "caching", "rate-limiting"] });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "critical", kind: "decision", title: "Cross B insight", concepts: ["api", "caching"] });

    const result = generateContext(db, "/project-a", "s-new", settings);
    expect(result).toContain("Cross-project");
    expect(result).toContain("Cross B insight");
  });

  test("excludes cross-project when disabled", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project-a", null);
    insertSession(db, "s2", "/project-b", null);
    insertObs(db, { sessionId: "s1", project: "/project-a", significance: "critical", kind: "decision", title: "Local A", concepts: ["api", "caching"] });
    insertObs(db, { sessionId: "s2", project: "/project-b", significance: "critical", kind: "decision", title: "Cross B", concepts: ["api", "caching"] });

    const result = generateContext(db, "/project-a", "s-new", DEFAULT_SETTINGS);
    expect(result).not.toContain("Cross-project");
  });

  test("respects context_budget setting", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", "A very long session summary");
    for (let i = 0; i < 50; i++) {
      insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "file_edit", title: `Observation number ${i} with some padding text` });
    }

    const settings: Settings = { ...DEFAULT_SETTINGS, context_budget: 500 };
    const result = generateContext(db, "/project", "s-new", settings);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  test("includes footer about MCP tools", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", "Session summary");

    const result = generateContext(db, "/project", "s-new", DEFAULT_SETTINGS);
    expect(result).toContain("deja_search/deja_timeline/deja_observe");
  });

  test("increments stats counters", () => {
    db = tmpDb();
    runMigrations(db);
    insertSession(db, "s1", "/project", "Summary");

    generateContext(db, "/project", "s-new", DEFAULT_SETTINGS);

    const injections = db.query("SELECT value FROM stats WHERE project = '/project' AND metric = 'context_injections'").get() as any;
    expect(injections.value).toBe(1);

    const chars = db.query("SELECT value FROM stats WHERE project = '/project' AND metric = 'context_chars_total'").get() as any;
    expect(chars.value).toBeGreaterThan(0);
  });

  test("unused session budget rolls to observations", () => {
    db = tmpDb();
    runMigrations(db);
    // No session summary — its 40% budget rolls to observations
    insertSession(db, "s1", "/project", null);
    for (let i = 0; i < 30; i++) {
      insertObs(db, { sessionId: "s1", project: "/project", significance: "high", kind: "file_edit", title: `Observation ${i} with some extra text to fill space` });
    }

    const result = generateContext(db, "/project", "s-new", DEFAULT_SETTINGS);
    // With rollover, observations should get more than their base 50% (4000 chars)
    const obsSection = result.split("## Key observations")[1] || "";
    // Just verify there are observations present (budget expanded from rollover)
    expect(obsSection).toContain("Observation");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/context/generator.test.ts`
Expected: FAIL — generateContext returns "" (stub)

- [ ] **Step 3: Replace generator stub with real implementation**

```typescript
// src/context/generator.ts — replace entire file
import type { Database } from "bun:sqlite";
import type { Settings } from "../types";
import {
  getLastSessionSummary,
  getTopObservations,
  getCrossProjectInsights,
} from "./queries";
import {
  formatSessionSection,
  formatObservationsSection,
  formatCrossProjectSection,
  formatContextBlock,
} from "./format";

export function generateContext(
  db: Database,
  project: string,
  _sessionId: string,
  settings: Settings,
): string {
  const budget = settings.context_budget;

  // Budget allocation: 40% session, 50% observations, 10% cross-project
  let sessionBudget = Math.floor(budget * 0.4);
  let obsBudget = Math.floor(budget * 0.5);
  let crossBudget = Math.floor(budget * 0.1);

  // Section 1: Last session summary
  const lastSession = getLastSessionSummary(db, project);
  const sessionSection = formatSessionSection(lastSession, sessionBudget);
  const sessionUnused = sessionBudget - sessionSection.length;

  // Roll unused session budget to observations
  obsBudget += sessionUnused;

  // Section 2: Top observations
  const observations = getTopObservations(db, project, 10);
  const obsSection = formatObservationsSection(observations, obsBudget);
  const obsUnused = obsBudget - obsSection.length;

  // Roll unused observations budget to cross-project
  crossBudget += obsUnused;

  // Section 3: Cross-project insights (opt-in)
  let crossSection = "";
  if (settings.cross_project) {
    const insights = getCrossProjectInsights(db, project, 2);
    crossSection = formatCrossProjectSection(insights, crossBudget);
  }

  const result = formatContextBlock(project, sessionSection, obsSection, crossSection);

  // Increment stats
  if (result) {
    db.prepare(
      `INSERT INTO stats (project, metric, value) VALUES (?, 'context_injections', 1)
       ON CONFLICT(project, metric) DO UPDATE SET value = value + 1`
    ).run(project);
    db.prepare(
      `INSERT INTO stats (project, metric, value) VALUES (?, 'context_chars_total', ?)
       ON CONFLICT(project, metric) DO UPDATE SET value = value + ?`
    ).run(project, result.length, result.length);
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/context/generator.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/context/generator.ts tests/context/generator.test.ts
git commit -m "feat: implement context injection with budget, queries, and stats tracking"
```

---

## Verification Checklist

After all tasks complete:

- [ ] `bun test` — all tests pass
- [ ] `bunx tsc --noEmit` — no type errors
- [ ] Context generator returns `<system-reminder>` block with session summary, observations, and cross-project sections
- [ ] Budget enforcement: session (40%) + observations (50%) + cross-project (10%) with rollover
- [ ] Cross-project matching requires 2+ shared concepts, only high/critical
- [ ] Stats counters incremented: `context_injections`, `context_chars_total`
- [ ] Empty database produces empty string (no injection on first session)
- [ ] `settings.cross_project = false` skips cross-project section
