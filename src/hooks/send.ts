import { sendToWorker, requestFromWorker } from "../kernel/socket";
import { appendToWal } from "../kernel/wal";
import type { EventMessage, RequestMessage } from "../types";

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
