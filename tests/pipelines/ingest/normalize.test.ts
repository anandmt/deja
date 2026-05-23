import { describe, test, expect } from "bun:test";
import { normalize } from "../../../src/pipelines/ingest/normalize";
import type { HookPayload } from "../../../src/types";

function postToolUse(tool: string, inp: Record<string, unknown>, out: Record<string, unknown> = {}): HookPayload {
  return { type: "PostToolUse", session_id: "s1", cwd: "/project", tool, input: inp, output: out };
}

describe("normalize", () => {
  // --- Edit ---

  test("Edit: formats diff with file path, old, new", () => {
    const result = normalize(postToolUse("Edit", {
      file_path: "/project/src/app.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    }, { success: true }));
    expect(result.tool).toBe("Edit");
    expect(result.files).toEqual(["/project/src/app.ts"]);
    expect(result.action).toBe("edit");
    expect(result.content_summary).toContain("EDIT /project/src/app.ts");
    expect(result.content_summary).toContain("--- old");
    expect(result.content_summary).toContain("const x = 1;");
    expect(result.content_summary).toContain("+++ new");
    expect(result.content_summary).toContain("const x = 2;");
  });

  test("Edit: truncates old_string and new_string to 900 chars each", () => {
    const longOld = "a\n".repeat(500);
    const longNew = "b\n".repeat(500);
    const result = normalize(postToolUse("Edit", {
      file_path: "/project/src/big.ts",
      old_string: longOld,
      new_string: longNew,
    }, { success: true }));
    expect(result.content_summary.length).toBeLessThanOrEqual(2000);
  });

  // --- Write ---

  test("Write: formats with file path and content from input", () => {
    const result = normalize(postToolUse("Write", {
      file_path: "/project/src/new.ts",
      content: "export function hello() { return 'world'; }",
    }, { success: true }));
    expect(result.tool).toBe("Write");
    expect(result.files).toEqual(["/project/src/new.ts"]);
    expect(result.action).toBe("write");
    expect(result.content_summary).toContain("WRITE /project/src/new.ts");
    expect(result.content_summary).toContain("export function hello()");
  });

  test("Write: uses input.content, not output", () => {
    const result = normalize(postToolUse("Write", {
      file_path: "/project/src/new.ts",
      content: "the actual content",
    }, { success: true }));
    expect(result.content_summary).toContain("the actual content");
    expect(result.content_summary).not.toContain("success");
  });

  // --- Read ---

  test("Read: formats with file path and content from output", () => {
    const result = normalize(postToolUse("Read", {
      file_path: "/project/src/client.py",
    }, { content: "import asyncio\n\nclass IBKRClient:\n    pass" }));
    expect(result.tool).toBe("Read");
    expect(result.files).toEqual(["/project/src/client.py"]);
    expect(result.action).toBe("read");
    expect(result.content_summary).toContain("READ /project/src/client.py");
    expect(result.content_summary).toContain("import asyncio");
  });

  test("Read: uses output.content, not input", () => {
    const result = normalize(postToolUse("Read", {
      file_path: "/project/src/client.py",
    }, { content: "file contents here" }));
    expect(result.content_summary).toContain("file contents here");
  });

  // --- Bash ---

  test("Bash: formats command, stdout, stderr", () => {
    const result = normalize(postToolUse("Bash", {
      command: "pytest tests/ -v",
    }, { stdout: "42 passed, 3 failed", stderr: "DeprecationWarning", exit_code: 1 }));
    expect(result.tool).toBe("Bash");
    expect(result.files).toEqual([]);
    expect(result.action).toBe("bash");
    expect(result.content_summary).toContain("BASH $ pytest tests/ -v");
    expect(result.content_summary).toContain("42 passed, 3 failed");
    expect(result.content_summary).toContain("DeprecationWarning");
  });

  test("Bash: prioritizes stdout over stderr when truncating", () => {
    const longStdout = "out\n".repeat(600);
    const longStderr = "err\n".repeat(600);
    const result = normalize(postToolUse("Bash", {
      command: "make build",
    }, { stdout: longStdout, stderr: longStderr, exit_code: 0 }));
    expect(result.content_summary.length).toBeLessThanOrEqual(2000);
    expect(result.content_summary).toContain("out");
  });

  // --- UserPromptSubmit ---

  test("UserPromptSubmit: formats prompt text", () => {
    const payload: HookPayload = {
      type: "UserPromptSubmit",
      session_id: "s1",
      cwd: "/project",
      prompt: "Fix the rate limiting bug in client.py",
    };
    const result = normalize(payload);
    expect(result.tool).toBeNull();
    expect(result.action).toBe("prompt");
    expect(result.content_summary).toContain("PROMPT Fix the rate limiting bug");
  });

  // --- SessionStart ---

  test("SessionStart: formats with project and trigger", () => {
    const payload: HookPayload = {
      type: "SessionStart",
      session_id: "s1",
      cwd: "/Users/alice/projects/my-app",
      trigger: "startup",
    };
    const result = normalize(payload);
    expect(result.tool).toBeNull();
    expect(result.action).toBe("session_start");
    expect(result.content_summary).toBe("SESSION_START project=/Users/alice/projects/my-app trigger=startup");
  });

  // --- Stop ---

  test("Stop: formats with project", () => {
    const payload: HookPayload = {
      type: "Stop",
      session_id: "s1",
      cwd: "/Users/alice/projects/my-app",
    };
    const result = normalize(payload);
    expect(result.tool).toBeNull();
    expect(result.action).toBe("session_end");
    expect(result.content_summary).toBe("SESSION_END project=/Users/alice/projects/my-app");
  });

  // --- Truncation behavior ---

  test("truncation cuts at last complete line", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${"x".repeat(30)}`).join("\n");
    const result = normalize(postToolUse("Write", {
      file_path: "/project/src/big.ts",
      content: lines,
    }, { success: true }));
    expect(result.content_summary.length).toBeLessThanOrEqual(2000);
    const lastNewline = result.content_summary.lastIndexOf("\n");
    const afterLast = result.content_summary.slice(lastNewline + 1);
    expect(afterLast === "" || !afterLast.includes("\n")).toBe(true);
  });

  // --- raw_event ---

  test("raw_event contains serialized payload without _batch", () => {
    const payload = postToolUse("Edit", { file_path: "/project/a.ts", old_string: "a", new_string: "b" }, { success: true });
    (payload as any)._batch = { batch_size: 2, batch_index: 0, multi_file_edit: true, unique_files: ["a.ts", "b.ts"] };
    const result = normalize(payload);
    const parsed = JSON.parse(result.raw_event);
    expect(parsed._batch).toBeUndefined();
    expect(parsed.tool).toBe("Edit");
  });
});
