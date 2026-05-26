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

  test("truncates to budget by dropping observations", () => {
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
