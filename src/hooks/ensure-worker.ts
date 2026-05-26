import { existsSync, readFileSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { acquireLock, releaseLock } from "../kernel/lock";

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface EnsureWorkerOptions {
  pidPath: string;
  sockPath: string;
  lockPath: string;
  workerScript: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

export async function ensureWorker(opts: EnsureWorkerOptions): Promise<void> {
  const {
    pidPath,
    sockPath,
    lockPath,
    workerScript,
    maxRetries = 10,
    retryDelayMs = 200,
  } = opts;

  if (isWorkerRunning(pidPath, sockPath)) return;

  const lockFd = acquireLock(lockPath);
  try {
    if (isWorkerRunning(pidPath, sockPath)) return;

    try { unlinkSync(pidPath); } catch {}
    try { unlinkSync(sockPath); } catch {}

    const child = spawn("bun", ["run", workerScript], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } finally {
    releaseLock(lockFd);
  }

  for (let i = 0; i < maxRetries; i++) {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    if (existsSync(sockPath)) return;
  }
}

function isWorkerRunning(pidPath: string, sockPath: string): boolean {
  if (!existsSync(pidPath)) return false;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (!isPidAlive(pid)) return false;
    return existsSync(sockPath);
  } catch {
    return false;
  }
}
