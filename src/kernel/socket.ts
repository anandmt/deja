import { unlinkSync } from "fs";
import type { Logger } from "./log";

export interface SocketServerOptions {
  socketPath: string;
  onMessage: (msg: any, respond: (response: any) => void) => void;
  onError?: (err: Error) => void;
  log?: Logger;
}

export class SocketServer {
  private server: ReturnType<typeof Bun.listen> | null = null;

  constructor(private options: SocketServerOptions) {}

  start(): void {
    const { socketPath, onMessage, onError, log } = this.options;

    try {
      unlinkSync(socketPath);
    } catch {}

    this.server = Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          (socket as any).ndjsonBuffer = "";
        },
        data(socket, data) {
          (socket as any).ndjsonBuffer += data.toString();
          const buf: string = (socket as any).ndjsonBuffer;
          const lines = buf.split("\n");
          (socket as any).ndjsonBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              onMessage(msg, (response: any) => {
                socket.write(JSON.stringify(response) + "\n");
              });
            } catch {
              log?.("warn", "socket", `Invalid JSON from client: ${line.slice(0, 100)}`);
            }
          }
        },
        close() {},
        error(_socket, error) {
          onError?.(error);
        },
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }
}

export async function sendToWorker(
  socketPath: string,
  message: unknown,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(message) + "\n");
          socket.end();
        },
        data() {},
        close() {
          resolve();
        },
        error(_socket, err) {
          reject(err);
        },
        connectError(_socket, err) {
          reject(err);
        },
      },
    }).catch(reject);
  });
}

export async function requestFromWorker(
  socketPath: string,
  message: unknown,
  timeoutMs: number = 10000,
): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Request timed out"));
      }
    }, timeoutMs);

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(message) + "\n");
        },
        data(socket, data) {
          if (settled) return;
          buffer += data.toString();
          const idx = buffer.indexOf("\n");
          if (idx !== -1) {
            settled = true;
            clearTimeout(timer);
            try {
              const response = JSON.parse(buffer.slice(0, idx));
              socket.end();
              resolve(response);
            } catch {
              socket.end();
              reject(new Error("Invalid response JSON"));
            }
          }
        },
        close() {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error("Connection closed without response"));
          }
        },
        error(_socket, err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        },
        connectError(_socket, err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        },
      },
    }).catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}
