import { sendToWorker, requestFromWorker } from "../kernel/socket";
import { appendToWal } from "../kernel/wal";
import type { EventMessage, RequestMessage } from "../types";

const DASHBOARD_NOTIFY_URL = `http://localhost:${process.env.DEJA_DASHBOARD_PORT ?? "19533"}/api/notify`;

export async function trySendEvent(
  socketPath: string,
  message: EventMessage,
  walPath: string,
  walLockPath: string,
): Promise<void> {
  try {
    await sendToWorker(socketPath, message);
  } catch {
    appendToWal(walPath, walLockPath, JSON.stringify(message.payload));
  }
  notifyDashboard();
}

export async function trySendRequest(
  socketPath: string,
  message: RequestMessage,
  timeoutMs: number,
): Promise<any | null> {
  try {
    return await requestFromWorker(socketPath, message, timeoutMs);
  } catch {
    return null;
  }
}

function notifyDashboard(): void {
  fetch(DASHBOARD_NOTIFY_URL, { method: "POST" }).catch(() => {});
}
