import type { HookPayload, BatchAnnotation } from "../../types";

type EmitFn = (payload: HookPayload, batch: BatchAnnotation) => void | Promise<void>;

interface SessionBuffer {
  events: HookPayload[];
  timer: ReturnType<typeof setTimeout>;
  uniqueFiles: Set<string>;
}

export class Debouncer {
  private buffers = new Map<string, SessionBuffer>();
  private emit: EmitFn;
  private windowMs: number;

  constructor(windowMs: number, emit: EmitFn) {
    this.windowMs = windowMs;
    this.emit = emit;
  }

  push(payload: HookPayload): void {
    const sid = payload.session_id;
    let buf = this.buffers.get(sid);

    if (!buf) {
      buf = {
        events: [],
        timer: setTimeout(() => this.flushSession(sid), this.windowMs),
        uniqueFiles: new Set(),
      };
      this.buffers.set(sid, buf);
    }

    buf.events.push(payload);

    const tool = (payload as any).tool as string | undefined;
    if (tool === "Edit" || tool === "Write") {
      const filePath = ((payload as any).input?.file_path ?? "") as string;
      if (filePath) buf.uniqueFiles.add(filePath);
    }
  }

  flush(): void {
    for (const sid of [...this.buffers.keys()]) {
      this.flushSession(sid);
    }
  }

  destroy(): void {
    for (const buf of this.buffers.values()) {
      clearTimeout(buf.timer);
    }
    this.buffers.clear();
  }

  private flushSession(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (!buf) return;

    clearTimeout(buf.timer);
    this.buffers.delete(sessionId);

    const uniqueFiles = [...buf.uniqueFiles];
    const multiFileEdit = uniqueFiles.length >= 2;
    const batchSize = buf.events.length;

    for (let i = 0; i < batchSize; i++) {
      const batch: BatchAnnotation = {
        batch_size: batchSize,
        batch_index: i,
        multi_file_edit: multiFileEdit,
        unique_files: uniqueFiles,
      };
      this.emit(buf.events[i], batch);
    }
  }
}
