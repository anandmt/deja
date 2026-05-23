import { openSync, closeSync, constants } from "fs";
import { dlopen, FFIType } from "bun:ffi";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const LIBC = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";

const { symbols } = dlopen(LIBC, {
  flock: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
});

function flockFd(fd: number, operation: number): number {
  return symbols.flock(fd, operation) as number;
}

export function acquireLock(path: string): number {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o644);
  const result = flockFd(fd, LOCK_EX);
  if (result !== 0) {
    closeSync(fd);
    throw new Error(`flock(LOCK_EX) failed on ${path}`);
  }
  return fd;
}

export function tryAcquireLock(path: string): number | null {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o644);
  const result = flockFd(fd, LOCK_EX | LOCK_NB);
  if (result !== 0) {
    closeSync(fd);
    return null;
  }
  return fd;
}

export function releaseLock(fd: number): void {
  try {
    flockFd(fd, LOCK_UN);
    closeSync(fd);
  } catch {
    // Already closed — safe to ignore
  }
}
