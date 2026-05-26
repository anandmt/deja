import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { rmSync } from "fs";
import { tmpDir } from "../../src/test/helpers";
import { SocketServer } from "../../src/kernel/socket";

async function runHook(
  scriptPath: string,
  stdinData: Record<string, unknown>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", scriptPath], {
    stdin: new Blob([JSON.stringify(stdinData)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe("Hook integration", () => {
  let dir: string;
  let server: SocketServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  test("post-tool-use exits cleanly (WAL fallback when no worker)", async () => {
    const hookScript = join(process.cwd(), "src/hooks/post-tool-use.ts");
    const result = await runHook(hookScript, {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/project/app.ts", old_string: "a", new_string: "b" },
      tool_output: { success: true },
    });

    expect(result.exitCode).toBe(0);
  });

  test("prompt-submit exits cleanly (WAL fallback when no worker)", async () => {
    const hookScript = join(process.cwd(), "src/hooks/prompt-submit.ts");
    const result = await runHook(hookScript, {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "UserPromptSubmit",
      prompt: "fix the bug",
    });

    expect(result.exitCode).toBe(0);
  });

  test("session-stop exits cleanly when no worker running", async () => {
    const hookScript = join(process.cwd(), "src/hooks/session-stop.ts");
    const result = await runHook(hookScript, {
      session_id: "s1",
      cwd: "/project",
      hook_event_name: "Stop",
    });

    expect(result.exitCode).toBe(0);
  });

  test("post-tool-use delivers event to running server", async () => {
    dir = tmpDir();
    const sockPath = join(dir, "worker.sock");
    const received: unknown[] = [];

    server = new SocketServer({
      socketPath: sockPath,
      onMessage: (msg) => received.push(msg),
    });
    server.start();

    // This test pipes to a hook that reads the real ~/.deja paths,
    // so the event won't reach our test server — but we can test
    // the mapPayload + send flow via direct import instead
    const { mapPayload } = await import("../../src/hooks/map-payload");
    const { trySendEvent } = await import("../../src/hooks/send");

    const raw = {
      session_id: "int-s1",
      cwd: "/project",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_output: { stdout: "ok", stderr: "", exit_code: 0 },
    };
    const payload = mapPayload(raw);
    await trySendEvent(
      sockPath,
      { type: "event", hook: payload.type, payload },
      join(dir, "pending.wal"),
      join(dir, "pending.wal.lock"),
    );

    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBe(1);
    const msg = received[0] as any;
    expect(msg.payload.type).toBe("PostToolUse");
    expect(msg.payload.tool).toBe("Bash");
    expect(msg.payload.input.command).toBe("npm test");
  });
});
