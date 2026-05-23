import { describe, test, expect } from "bun:test";
import { Debouncer } from "../../../src/pipelines/ingest/debounce";
import type { HookPayload, BatchAnnotation } from "../../../src/types";

function makePayload(sessionId: string, tool: string = "Edit", filePath: string = "/project/a.ts"): HookPayload {
  return {
    type: "PostToolUse",
    session_id: sessionId,
    cwd: "/project",
    tool,
    input: { file_path: filePath, old_string: "a", new_string: "b" },
    output: { success: true },
  };
}

describe("Debouncer", () => {
  test("single event emits after debounce window", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1"));
    expect(emitted.length).toBe(0);

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(1);
    expect(emitted[0].batch.batch_size).toBe(1);
    expect(emitted[0].batch.batch_index).toBe(0);
    expect(emitted[0].batch.multi_file_edit).toBe(false);

    debouncer.destroy();
  });

  test("multiple events in same window emit as batch", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1", "Edit", "/project/a.ts"));
    debouncer.push(makePayload("s1", "Edit", "/project/b.ts"));
    debouncer.push(makePayload("s1", "Edit", "/project/a.ts"));

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(3);
    expect(emitted[0].batch.batch_size).toBe(3);
    expect(emitted[0].batch.multi_file_edit).toBe(true);
    expect(emitted[0].batch.unique_files).toEqual(["/project/a.ts", "/project/b.ts"]);
    expect(emitted[1].batch.batch_index).toBe(1);
    expect(emitted[2].batch.batch_index).toBe(2);

    debouncer.destroy();
  });

  test("different sessions are debounced independently", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1"));
    debouncer.push(makePayload("s2"));

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(2);
    expect(emitted[0].batch.batch_size).toBe(1);
    expect(emitted[1].batch.batch_size).toBe(1);

    debouncer.destroy();
  });

  test("window is fixed — new events do not extend the timer", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1", "Edit", "/project/a.ts"));
    await new Promise((r) => setTimeout(r, 30));
    debouncer.push(makePayload("s1", "Edit", "/project/b.ts"));

    await new Promise((r) => setTimeout(r, 40));
    expect(emitted.length).toBe(2);

    debouncer.destroy();
  });

  test("multi_file_edit is false for single-file batch", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1", "Edit", "/project/a.ts"));
    debouncer.push(makePayload("s1", "Edit", "/project/a.ts"));

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted[0].batch.multi_file_edit).toBe(false);
    expect(emitted[0].batch.unique_files).toEqual(["/project/a.ts"]);

    debouncer.destroy();
  });

  test("non-Edit/Write events do not contribute to unique_files", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1", "Edit", "/project/a.ts"));
    debouncer.push({
      type: "PostToolUse", session_id: "s1", cwd: "/project",
      tool: "Bash", input: { command: "ls" }, output: { stdout: "", stderr: "", exit_code: 0 },
    });

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(2);
    expect(emitted[0].batch.unique_files).toEqual(["/project/a.ts"]);
    expect(emitted[0].batch.multi_file_edit).toBe(false);

    debouncer.destroy();
  });

  test("flush() emits pending events immediately", () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(5000, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1"));
    debouncer.push(makePayload("s2"));
    expect(emitted.length).toBe(0);

    debouncer.flush();
    expect(emitted.length).toBe(2);

    debouncer.destroy();
  });

  test("destroy() clears all timers and pending events", async () => {
    const emitted: Array<{ payload: HookPayload; batch: BatchAnnotation }> = [];
    const debouncer = new Debouncer(50, (payload, batch) => {
      emitted.push({ payload, batch });
    });

    debouncer.push(makePayload("s1"));
    debouncer.destroy();

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(0);
  });
});
