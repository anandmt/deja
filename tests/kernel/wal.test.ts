import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { rmSync } from "fs";
import { tmpDir } from "../../src/test/helpers";
import { appendToWal, drainWal, walSize } from "../../src/kernel/wal";

describe("appendToWal", () => {
  let dir: string;
  let walPath: string;
  let lockPath: string;

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("creates WAL file and appends event", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    appendToWal(walPath, lockPath, '{"type":"event","hook":"PostToolUse"}');
    expect(existsSync(walPath)).toBe(true);
    const content = readFileSync(walPath, "utf-8");
    expect(content).toBe('{"type":"event","hook":"PostToolUse"}\n');
  });

  test("appends multiple events on separate lines", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    appendToWal(walPath, lockPath, '{"n":1}');
    appendToWal(walPath, lockPath, '{"n":2}');
    appendToWal(walPath, lockPath, '{"n":3}');
    const lines = readFileSync(walPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[2]).n).toBe(3);
  });
});

describe("drainWal", () => {
  let dir: string;
  let walPath: string;
  let lockPath: string;

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("returns empty array when WAL does not exist", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    const events = drainWal(walPath, lockPath);
    expect(events).toEqual([]);
  });

  test("returns empty array when WAL is empty", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    writeFileSync(walPath, "");
    const events = drainWal(walPath, lockPath);
    expect(events).toEqual([]);
  });

  test("drains all valid events and truncates WAL", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    writeFileSync(walPath, '{"n":1}\n{"n":2}\n{"n":3}\n');
    const events = drainWal(walPath, lockPath);
    expect(events.length).toBe(3);
    expect(JSON.parse(events[0]).n).toBe(1);
    expect(JSON.parse(events[2]).n).toBe(3);
    expect(readFileSync(walPath, "utf-8")).toBe("");
  });

  test("skips incomplete last line (crash recovery)", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    writeFileSync(walPath, '{"n":1}\n{"n":2}\n{"incomplete":');
    const events = drainWal(walPath, lockPath);
    expect(events.length).toBe(2);
    expect(JSON.parse(events[1]).n).toBe(2);
  });

  test("skips malformed line in middle", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    writeFileSync(walPath, '{"n":1}\nNOT_JSON\n{"n":3}\n');
    const events = drainWal(walPath, lockPath);
    expect(events.length).toBe(2);
    expect(JSON.parse(events[0]).n).toBe(1);
    expect(JSON.parse(events[1]).n).toBe(3);
  });

  test("append then drain round-trips", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    appendToWal(walPath, lockPath, '{"round":"trip"}');
    const events = drainWal(walPath, lockPath);
    expect(events.length).toBe(1);
    expect(JSON.parse(events[0]).round).toBe("trip");
    expect(readFileSync(walPath, "utf-8")).toBe("");
  });
});

describe("walSize", () => {
  let dir: string;

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("returns 0 when file does not exist", () => {
    dir = tmpDir();
    expect(walSize(join(dir, "nope.wal"))).toBe(0);
  });

  test("returns file size in bytes", () => {
    dir = tmpDir();
    const path = join(dir, "test.wal");
    writeFileSync(path, "hello\n");
    expect(walSize(path)).toBe(6);
  });
});

describe("appendToWal size cap", () => {
  let dir: string;
  let walPath: string;
  let lockPath: string;

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("drops event when WAL exceeds 10MB", () => {
    dir = tmpDir();
    walPath = join(dir, "pending.wal");
    lockPath = join(dir, "pending.wal.lock");
    writeFileSync(walPath, "x".repeat(10 * 1024 * 1024 + 1));
    const sizeBefore = walSize(walPath);
    appendToWal(walPath, lockPath, '{"dropped":true}');
    expect(walSize(walPath)).toBe(sizeBefore);
  });
});
