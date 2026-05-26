import { describe, test, expect } from "bun:test";
import { mapPayload } from "../../src/hooks/map-payload";

describe("mapPayload", () => {
  test("maps SessionStart fields", () => {
    const raw = {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "SessionStart",
      source: "startup",
      transcript_path: "/path/to/transcript.jsonl",
      model: "claude-sonnet-4-6",
    };
    const result = mapPayload(raw);
    expect(result.type).toBe("SessionStart");
    expect(result.session_id).toBe("s1");
    expect(result.cwd).toBe("/project");
    expect((result as any).trigger).toBe("startup");
    expect((result as any).transcript_path).toBeUndefined();
    expect((result as any).model).toBeUndefined();
  });

  test("maps PostToolUse Edit fields", () => {
    const raw = {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/project/app.ts", old_string: "a", new_string: "b" },
      tool_output: { success: true },
      tool_use_id: "tu_123",
    };
    const result = mapPayload(raw);
    expect(result.type).toBe("PostToolUse");
    expect((result as any).tool).toBe("Edit");
    expect((result as any).input).toEqual({ file_path: "/project/app.ts", old_string: "a", new_string: "b" });
    expect((result as any).output).toEqual({ success: true });
    expect((result as any).tool_use_id).toBeUndefined();
  });

  test("maps PostToolUse Bash fields", () => {
    const raw = {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_output: { stdout: "ok", stderr: "", exit_code: 0 },
    };
    const result = mapPayload(raw);
    expect((result as any).tool).toBe("Bash");
    expect((result as any).input).toEqual({ command: "npm test" });
    expect((result as any).output).toEqual({ stdout: "ok", stderr: "", exit_code: 0 });
  });

  test("maps UserPromptSubmit fields", () => {
    const raw = {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "UserPromptSubmit",
      prompt: "fix the bug",
      permission_mode: "default",
    };
    const result = mapPayload(raw);
    expect(result.type).toBe("UserPromptSubmit");
    expect((result as any).prompt).toBe("fix the bug");
    expect((result as any).permission_mode).toBeUndefined();
  });

  test("maps Stop fields", () => {
    const raw = {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "Stop",
    };
    const result = mapPayload(raw);
    expect(result.type).toBe("Stop");
    expect(result.session_id).toBe("s1");
    expect(result.cwd).toBe("/project");
  });

  test("handles tool_response as fallback for tool_output", () => {
    const raw = {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/project/foo.ts" },
      tool_response: { content: "file contents" },
    };
    const result = mapPayload(raw);
    expect((result as any).output).toEqual({ content: "file contents" });
  });
});
