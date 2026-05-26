import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpDir } from "../../src/test/helpers";
import { isPidAlive, ensureWorker } from "../../src/hooks/ensure-worker";
import { SocketServer } from "../../src/kernel/socket";

describe("isPidAlive", () => {
  test("returns true for current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("returns false for non-existent PID", () => {
    expect(isPidAlive(999999)).toBe(false);
  });
});

describe("ensureWorker", () => {
  let dir: string;
  let server: SocketServer | null = null;
  const spawnedPids: number[] = [];

  afterEach(() => {
    server?.stop();
    server = null;
    for (const pid of spawnedPids) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    spawnedPids.length = 0;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test("returns immediately if worker is already running", async () => {
    dir = tmpDir();
    const pidPath = join(dir, "worker.pid");
    const sockPath = join(dir, "worker.sock");
    const lockPath = join(dir, "worker.lock");

    server = new SocketServer({
      socketPath: sockPath,
      onMessage: () => {},
    });
    server.start();
    writeFileSync(pidPath, String(process.pid));

    const start = Date.now();
    await ensureWorker({
      pidPath,
      sockPath,
      lockPath,
      workerScript: "unused",
    });
    const elapsed = Date.now() - start;

    // Should return very quickly (< 100ms) — no spawning
    expect(elapsed).toBeLessThan(100);
  });

  test("spawns worker when no PID file exists", async () => {
    dir = tmpDir();
    const pidPath = join(dir, "worker.pid");
    const sockPath = join(dir, "worker.sock");
    const lockPath = join(dir, "worker.lock");

    const testWorker = join(dir, "fake-worker.ts");
    writeFileSync(testWorker, `
import { writeFileSync, unlinkSync } from "fs";

try { unlinkSync("${sockPath}"); } catch {}

Bun.listen({
  unix: "${sockPath}",
  socket: {
    open() {},
    data() {},
    close() {},
    error() {},
  },
});

writeFileSync("${pidPath}", String(process.pid));
setInterval(() => {}, 60000);
`);

    await ensureWorker({
      pidPath,
      sockPath,
      lockPath,
      workerScript: testWorker,
      maxRetries: 30,
      retryDelayMs: 100,
    });

    expect(existsSync(pidPath)).toBe(true);
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    expect(pid).toBeGreaterThan(0);
    spawnedPids.push(pid);
  });

  test("cleans up stale PID and respawns", async () => {
    dir = tmpDir();
    const pidPath = join(dir, "worker.pid");
    const sockPath = join(dir, "worker.sock");
    const lockPath = join(dir, "worker.lock");

    writeFileSync(pidPath, "999999");

    const testWorker = join(dir, "fake-worker.ts");
    writeFileSync(testWorker, `
import { writeFileSync, unlinkSync } from "fs";

try { unlinkSync("${sockPath}"); } catch {}

Bun.listen({
  unix: "${sockPath}",
  socket: {
    open() {},
    data() {},
    close() {},
    error() {},
  },
});

writeFileSync("${pidPath}", String(process.pid));
setInterval(() => {}, 60000);
`);

    await ensureWorker({
      pidPath,
      sockPath,
      lockPath,
      workerScript: testWorker,
      maxRetries: 30,
      retryDelayMs: 100,
    });

    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    expect(pid).not.toBe(999999);
    expect(pid).toBeGreaterThan(0);
    spawnedPids.push(pid);
  });
});
