import { existsSync, readFileSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { acquireLock, releaseLock } from "../kernel/lock";
import { isPidAlive } from "./ensure-worker";

export interface EnsureDashboardOptions {
  pidPath: string;
  lockPath: string;
  dashboardScript: string;
}

export function ensureDashboard(opts: EnsureDashboardOptions): void {
  const { pidPath, lockPath, dashboardScript } = opts;

  if (isDashboardRunning(pidPath)) return;

  const lockFd = acquireLock(lockPath);
  try {
    if (isDashboardRunning(pidPath)) return;

    try { unlinkSync(pidPath); } catch {}

    const child = spawn("bun", ["run", dashboardScript], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } finally {
    releaseLock(lockFd);
  }
}

function isDashboardRunning(pidPath: string): boolean {
  if (!existsSync(pidPath)) return false;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    return isPidAlive(pid);
  } catch {
    return false;
  }
}
