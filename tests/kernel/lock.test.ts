import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { acquireLock, releaseLock, tryAcquireLock } from "../../src/kernel/lock";

describe("lock", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("acquireLock creates lock file and returns fd", () => {
    dir = mkdtempSync(join(tmpdir(), "deja-lock-"));
    const lockPath = join(dir, "test.lock");
    const fd = acquireLock(lockPath);
    expect(typeof fd).toBe("number");
    expect(fd).toBeGreaterThan(0);
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(fd);
  });

  test("releaseLock releases the lock allowing re-acquisition", () => {
    dir = mkdtempSync(join(tmpdir(), "deja-lock-"));
    const lockPath = join(dir, "test.lock");
    const fd1 = acquireLock(lockPath);
    releaseLock(fd1);
    const fd2 = acquireLock(lockPath);
    expect(typeof fd2).toBe("number");
    releaseLock(fd2);
  });

  test("tryAcquireLock returns null when lock is held by another process", async () => {
    dir = mkdtempSync(join(tmpdir(), "deja-lock-"));
    const lockPath = join(dir, "test.lock");
    // Spawn a child process that acquires the lock and holds it
    const child = Bun.spawn(["bun", "-e", `
      const { openSync, closeSync, constants } = require("fs");
      const { dlopen, FFIType } = require("bun:ffi");
      const LIBC = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";
      const { symbols } = dlopen(LIBC, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
      const fd = openSync("${lockPath}", constants.O_RDWR | constants.O_CREAT, 0o644);
      symbols.flock(fd, 2); // LOCK_EX
      process.stdout.write("locked");
      // Hold lock until stdin closes
      await Bun.stdin.text();
      symbols.flock(fd, 8); // LOCK_UN
      closeSync(fd);
    `], { stdout: "pipe", stdin: "pipe" });
    // Wait for child to acquire the lock
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("locked");
    // Now try from parent — should fail
    const fd = tryAcquireLock(lockPath);
    expect(fd).toBeNull();
    // Cleanup: close child stdin to let it exit
    child.stdin.end();
    await child.exited;
  });

  test("tryAcquireLock succeeds when lock is not held", () => {
    dir = mkdtempSync(join(tmpdir(), "deja-lock-"));
    const lockPath = join(dir, "test.lock");
    const fd = tryAcquireLock(lockPath);
    expect(fd).not.toBeNull();
    if (fd !== null) releaseLock(fd);
  });
});
