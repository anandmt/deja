import type { HookPayload, NormalizedEvent } from "../../types";

const MAX_CONTENT = 2000;
const MAX_EDIT_HALF = 900;

function truncateAtLine(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf("\n", maxLen);
  return cut > 0 ? text.slice(0, cut + 1) : text.slice(0, maxLen);
}

function stripBatch(payload: HookPayload): string {
  const copy = { ...payload } as Record<string, unknown>;
  delete copy._batch;
  return JSON.stringify(copy);
}

export function normalize(payload: HookPayload): NormalizedEvent {
  const tool = (payload as any).tool as string | undefined;
  const inp = (payload as any).input as Record<string, unknown> | undefined;
  const out = (payload as any).output as Record<string, unknown> | undefined;

  if (payload.type === "SessionStart") {
    return {
      tool: null,
      files: [],
      action: "session_start",
      content_summary: `SESSION_START project=${payload.cwd} trigger=${(payload as any).trigger ?? "unknown"}`,
      raw_event: stripBatch(payload),
    };
  }

  if (payload.type === "Stop") {
    return {
      tool: null,
      files: [],
      action: "session_end",
      content_summary: `SESSION_END project=${payload.cwd}`,
      raw_event: stripBatch(payload),
    };
  }

  if (payload.type === "UserPromptSubmit") {
    const prompt = ((payload as any).prompt ?? "") as string;
    return {
      tool: null,
      files: [],
      action: "prompt",
      content_summary: truncateAtLine(`PROMPT ${prompt}`, MAX_CONTENT),
      raw_event: stripBatch(payload),
    };
  }

  // PostToolUse
  const filePath = (inp?.file_path ?? "") as string;
  const files = filePath ? [filePath] : [];

  if (tool === "Edit") {
    const oldStr = truncateAtLine((inp?.old_string ?? "") as string, MAX_EDIT_HALF);
    const newStr = truncateAtLine((inp?.new_string ?? "") as string, MAX_EDIT_HALF);
    return {
      tool: "Edit",
      files,
      action: "edit",
      content_summary: truncateAtLine(`EDIT ${filePath}\n--- old\n${oldStr}\n+++ new\n${newStr}`, MAX_CONTENT),
      raw_event: stripBatch(payload),
    };
  }

  if (tool === "Write") {
    const content = (inp?.content ?? "") as string;
    return {
      tool: "Write",
      files,
      action: "write",
      content_summary: truncateAtLine(`WRITE ${filePath}\n${content}`, MAX_CONTENT),
      raw_event: stripBatch(payload),
    };
  }

  if (tool === "Read") {
    const content = (out?.content ?? "") as string;
    return {
      tool: "Read",
      files,
      action: "read",
      content_summary: truncateAtLine(`READ ${filePath}\n${content}`, MAX_CONTENT),
      raw_event: stripBatch(payload),
    };
  }

  if (tool === "Bash") {
    const command = (inp?.command ?? "") as string;
    const stdout = (out?.stdout ?? "") as string;
    const stderr = (out?.stderr ?? "") as string;
    const header = `BASH $ ${command}\n`;
    const budget = MAX_CONTENT - header.length;
    const stderrBudget = Math.min(stderr.length, Math.floor(budget * 0.25));
    const stdoutBudget = Math.min(stdout.length, budget - stderrBudget);
    const truncStdout = truncateAtLine(stdout, stdoutBudget);
    const truncStderr = truncateAtLine(stderr, stderrBudget);
    let summary = header + truncStdout;
    if (truncStderr) summary += "\n" + truncStderr;
    return {
      tool: "Bash",
      files: [],
      action: "bash",
      content_summary: summary.slice(0, MAX_CONTENT),
      raw_event: stripBatch(payload),
    };
  }

  // Unknown tool — best effort
  return {
    tool: tool ?? null,
    files,
    action: tool?.toLowerCase() ?? "unknown",
    content_summary: truncateAtLine(JSON.stringify(inp ?? {}), MAX_CONTENT),
    raw_event: stripBatch(payload),
  };
}
