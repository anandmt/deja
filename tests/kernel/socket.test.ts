import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { rmSync } from "fs";
import { tmpDir } from "../../src/test/helpers";
import {
  SocketServer,
  sendToWorker,
  requestFromWorker,
} from "../../src/kernel/socket";

describe("SocketServer", () => {
  let dir: string;
  let socketPath: string;
  let server: SocketServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("receives fire-and-forget message", async () => {
    dir = tmpDir();
    socketPath = join(dir, "test.sock");
    const received: unknown[] = [];

    server = new SocketServer({
      socketPath,
      onMessage: (msg) => {
        received.push(msg);
      },
    });
    server.start();

    await sendToWorker(socketPath, {
      type: "event",
      hook: "PostToolUse",
      payload: { session_id: "s1", cwd: "/test" },
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBe(1);
    expect((received[0] as any).type).toBe("event");
  });

  test("receives multiple messages from separate clients", async () => {
    dir = tmpDir();
    socketPath = join(dir, "test.sock");
    const received: unknown[] = [];

    server = new SocketServer({
      socketPath,
      onMessage: (msg) => {
        received.push(msg);
      },
    });
    server.start();

    await sendToWorker(socketPath, { type: "event", n: 1 });
    await sendToWorker(socketPath, { type: "event", n: 2 });
    await sendToWorker(socketPath, { type: "event", n: 3 });

    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBe(3);
  });

  test("handles request-response pattern", async () => {
    dir = tmpDir();
    socketPath = join(dir, "test.sock");

    server = new SocketServer({
      socketPath,
      onMessage: (msg, respond) => {
        if (msg.type === "request") {
          respond({ type: "response", id: msg.id, status: "ok" });
        }
      },
    });
    server.start();

    const response = await requestFromWorker(
      socketPath,
      { type: "request", id: "req-1", hook: "Stop", payload: {} },
      5000,
    );

    expect(response.type).toBe("response");
    expect(response.id).toBe("req-1");
    expect(response.status).toBe("ok");
  });

  test("requestFromWorker times out when no response", async () => {
    dir = tmpDir();
    socketPath = join(dir, "test.sock");

    server = new SocketServer({
      socketPath,
      onMessage: () => {
        // intentionally no response
      },
    });
    server.start();

    await expect(
      requestFromWorker(
        socketPath,
        { type: "request", id: "req-2", hook: "Stop", payload: {} },
        200,
      ),
    ).rejects.toThrow(/timed out/i);
  });

  test("sendToWorker rejects when no server is listening", async () => {
    dir = tmpDir();
    socketPath = join(dir, "nonexistent.sock");

    await expect(
      sendToWorker(socketPath, { type: "event" }),
    ).rejects.toThrow();
  });

  test("handles multiple newline-delimited messages in one data chunk", async () => {
    dir = tmpDir();
    socketPath = join(dir, "test.sock");
    const received: unknown[] = [];

    server = new SocketServer({
      socketPath,
      onMessage: (msg) => {
        received.push(msg);
      },
    });
    server.start();

    await Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          s.write('{"n":1}\n{"n":2}\n');
          s.end();
        },
        data() {},
        close() {},
        error() {},
      },
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBe(2);
    expect((received[0] as any).n).toBe(1);
    expect((received[1] as any).n).toBe(2);
  });
});
