import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { rmSync, existsSync, readFileSync } from "fs";
import { tmpDir } from "../../src/test/helpers";
import { SocketServer } from "../../src/kernel/socket";
import { trySendEvent, trySendRequest } from "../../src/hooks/send";

describe("trySendEvent", () => {
  let dir: string;
  let server: SocketServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test("sends event to running worker", async () => {
    dir = tmpDir();
    const sockPath = join(dir, "test.sock");
    const walPath = join(dir, "pending.wal");
    const walLock = join(dir, "pending.wal.lock");
    const received: unknown[] = [];

    server = new SocketServer({
      socketPath: sockPath,
      onMessage: (msg) => received.push(msg),
    });
    server.start();

    await trySendEvent(
      sockPath,
      { type: "event", hook: "PostToolUse", payload: { type: "PostToolUse", session_id: "s1", cwd: "/p" } },
      walPath,
      walLock,
    );

    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBe(1);
    expect(existsSync(walPath)).toBe(false);
  });

  test("falls back to WAL when no server", async () => {
    dir = tmpDir();
    const sockPath = join(dir, "nonexistent.sock");
    const walPath = join(dir, "pending.wal");
    const walLock = join(dir, "pending.wal.lock");

    await trySendEvent(
      sockPath,
      { type: "event", hook: "PostToolUse", payload: { type: "PostToolUse", session_id: "s1", cwd: "/p" } },
      walPath,
      walLock,
    );

    expect(existsSync(walPath)).toBe(true);
    const content = readFileSync(walPath, "utf-8");
    expect(content).toContain("PostToolUse");
  });
});

describe("trySendRequest", () => {
  let dir: string;
  let server: SocketServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test("sends request and receives response", async () => {
    dir = tmpDir();
    const sockPath = join(dir, "test.sock");

    server = new SocketServer({
      socketPath: sockPath,
      onMessage: (msg, respond) => {
        if (msg.type === "request") {
          respond({ type: "response", id: msg.id, status: "ok" });
        }
      },
    });
    server.start();

    const response = await trySendRequest(
      sockPath,
      { type: "request", id: "r1", hook: "Stop", payload: { type: "Stop", session_id: "s1", cwd: "/p" } },
      5000,
    );

    expect(response.status).toBe("ok");
  });

  test("returns null on timeout", async () => {
    dir = tmpDir();
    const sockPath = join(dir, "test.sock");

    server = new SocketServer({
      socketPath: sockPath,
      onMessage: () => {},
    });
    server.start();

    const response = await trySendRequest(
      sockPath,
      { type: "request", id: "r2", hook: "Stop", payload: { type: "Stop", session_id: "s1", cwd: "/p" } },
      200,
    );

    expect(response).toBeNull();
  });

  test("returns null when no server", async () => {
    dir = tmpDir();
    const sockPath = join(dir, "nonexistent.sock");

    const response = await trySendRequest(
      sockPath,
      { type: "request", id: "r3", hook: "Stop", payload: { type: "Stop", session_id: "s1", cwd: "/p" } },
      200,
    );

    expect(response).toBeNull();
  });
});
