import { describe, test, expect } from "bun:test";
import { classify } from "../../../src/pipelines/ingest/classify";
import type { HookPayload, BatchAnnotation, ClassifyInput } from "../../../src/types";

function input(
  payload: HookPayload,
  opts: { recentCommands?: Set<string>; seenWritePaths?: Set<string>; excludedProjects?: string[]; batch?: BatchAnnotation } = {}
): ClassifyInput {
  return {
    payload,
    recentCommands: opts.recentCommands ?? new Set(),
    seenWritePaths: opts.seenWritePaths ?? new Set(),
    settings: { excluded_projects: opts.excludedProjects ?? [] },
    batch: opts.batch,
  };
}

function postToolUse(tool: string, inp: Record<string, unknown>, out: Record<string, unknown> = {}): HookPayload {
  return { type: "PostToolUse", session_id: "s1", cwd: "/project", tool, input: inp, output: out };
}

describe("classify", () => {
  // --- SKIP rules ---

  test("SKIP: excluded project", () => {
    const payload: HookPayload = { type: "PostToolUse", session_id: "s1", cwd: "/secret/repo", tool: "Read", input: { file_path: "/secret/repo/foo.ts" }, output: {} };
    const result = classify(input(payload, { excludedProjects: ["/secret/repo"] }));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("excluded_project");
  });

  test("SKIP: noise file read — node_modules", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/node_modules/foo/index.js" }, { content: "..." })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("noise_file_read");
  });

  test("SKIP: noise file read — .git directory", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/.git/config" }, { content: "..." })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("noise_file_read");
  });

  test("SKIP: noise file read — lock files", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/package-lock.json" }, { content: "..." })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("noise_file_read");
  });

  test("SKIP: noise file read — dist directory", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/dist/bundle.js" }, { content: "..." })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("noise_file_read");
  });

  test("SKIP: noise file extension — .map", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/src/app.js.map" }, { content: "..." })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("noise_file_extension");
  });

  test("SKIP: noise file extension — .min.js", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/vendor/lib.min.js" }, { content: "..." })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("noise_file_extension");
  });

  test("SKIP: duplicate bash command within 60s", () => {
    const recent = new Set(["pytest tests/:1700000000000"]);
    const now = 1700000030000;
    const payload = postToolUse("Bash", { command: "pytest tests/" }, { stdout: "", stderr: "", exit_code: 0 });
    const result = classify(input(payload, { recentCommands: recent }), now);
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("duplicate_bash");
  });

  test("does NOT skip bash command if older than 60s", () => {
    const recent = new Set(["pytest tests/:1700000000000"]);
    const now = 1700000070000;
    const payload = postToolUse("Bash", { command: "pytest tests/" }, { stdout: "", stderr: "", exit_code: 0 });
    const result = classify(input(payload, { recentCommands: recent }), now);
    expect(result.significance).not.toBe("skip");
  });

  test("SKIP: navigation commands", () => {
    for (const cmd of ["ls", "pwd", "cd src", "echo $PATH", "which node", "type git"]) {
      const result = classify(input(postToolUse("Bash", { command: cmd }, { stdout: "", stderr: "", exit_code: 0 })));
      expect(result.significance).toBe("skip");
      expect(result.rule).toBe("navigation_command");
    }
  });

  test("SKIP: credential files", () => {
    for (const path of ["/project/.env", "/project/.env.local", "/project/server.pem", "/project/server.key", "/project/credentials.json", "/project/config/.secrets.yaml"]) {
      const result = classify(input(postToolUse("Read", { file_path: path }, { content: "..." })));
      expect(result.significance).toBe("skip");
      expect(result.rule).toBe("credential_file");
    }
  });

  // --- CRITICAL rules ---

  test("CRITICAL: dependency file changed", () => {
    for (const path of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "requirements.txt", "Gemfile"]) {
      const result = classify(input(postToolUse("Edit", { file_path: `/project/${path}`, old_string: "a", new_string: "b" }, { success: true })));
      expect(result.significance).toBe("critical");
      expect(result.rule).toBe("dependency_file_changed");
    }
  });

  test("CRITICAL: decision in prompt", () => {
    for (const phrase of ["let's use Redis", "switch to PostgreSQL", "we should refactor", "decided to go with SSR", "choosing WebSockets", "going with approach B"]) {
      const payload: HookPayload = { type: "UserPromptSubmit", session_id: "s1", cwd: "/project", prompt: phrase };
      const result = classify(input(payload));
      expect(result.significance).toBe("critical");
      expect(result.rule).toBe("decision_prompt");
    }
  });

  test("non-decision prompt is MEDIUM (default)", () => {
    const payload: HookPayload = { type: "UserPromptSubmit", session_id: "s1", cwd: "/project", prompt: "fix the bug in login.ts" };
    const result = classify(input(payload));
    expect(result.significance).toBe("medium");
  });

  // --- HIGH rules ---

  test("HIGH: multi-file edit batch", () => {
    const batch: BatchAnnotation = { batch_size: 3, batch_index: 0, multi_file_edit: true, unique_files: ["a.ts", "b.ts"] };
    const result = classify(input(postToolUse("Edit", { file_path: "/project/a.ts", old_string: "a", new_string: "b" }, { success: true }), { batch }));
    expect(result.significance).toBe("high");
    expect(result.rule).toBe("multi_file_edit");
  });

  test("HIGH: test failure", () => {
    const result = classify(input(postToolUse("Bash", { command: "bun test" }, { stdout: "3 fail", stderr: "", exit_code: 1 })));
    expect(result.significance).toBe("high");
    expect(result.rule).toBe("test_failure");
  });

  test("HIGH: error debugging — long stderr", () => {
    const longStderr = "E".repeat(201);
    const result = classify(input(postToolUse("Bash", { command: "node server.js" }, { stdout: "", stderr: longStderr, exit_code: 1 })));
    expect(result.significance).toBe("high");
    expect(result.rule).toBe("error_debugging");
  });

  // --- LOW rules ---

  test("LOW: config file read", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/tsconfig.json" }, { content: "{}" })));
    expect(result.significance).toBe("low");
    expect(result.rule).toBe("config_file_read");
  });

  test("LOW: simple grep with short output", () => {
    const result = classify(input(postToolUse("Bash", { command: "grep -r 'TODO' src/" }, { stdout: "src/a.ts:TODO fix", stderr: "", exit_code: 0 })));
    expect(result.significance).toBe("low");
    expect(result.rule).toBe("simple_grep");
  });

  // --- DEFAULT ---

  test("MEDIUM: default for unmatched events", () => {
    const result = classify(input(postToolUse("Edit", { file_path: "/project/src/app.ts", old_string: "a", new_string: "b" }, { success: true })));
    expect(result.significance).toBe("medium");
    expect(result.rule).toBe("default");
  });

  // --- Priority ---

  test("credential file SKIP takes priority over config LOW", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/.env.production" }, { content: "SECRET=abc" })));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("credential_file");
  });

  test("dependency Edit is CRITICAL even if it's a config file", () => {
    const result = classify(input(postToolUse("Edit", { file_path: "/project/package.json", old_string: "a", new_string: "b" }, { success: true })));
    expect(result.significance).toBe("critical");
    expect(result.rule).toBe("dependency_file_changed");
  });

  // --- new_source_file edge cases ---

  test("CRITICAL: new source file — first Write to path is CRITICAL", () => {
    const result = classify(input(postToolUse("Write", { file_path: "/project/src/new-module.ts", content: "export class Foo {}" }, { success: true }), { seenWritePaths: new Set() }));
    expect(result.significance).toBe("critical");
    expect(result.rule).toBe("new_source_file");
  });

  test("subsequent Write to same path is MEDIUM (default), not CRITICAL", () => {
    const seen = new Set(["/project/src/new-module.ts"]);
    const result = classify(input(postToolUse("Write", { file_path: "/project/src/new-module.ts", content: "export class Foo { updated }" }, { success: true }), { seenWritePaths: seen }));
    expect(result.significance).toBe("medium");
    expect(result.rule).toBe("default");
  });

  test("Write to dist/ is NOT critical (not a source dir or project root file)", () => {
    const result = classify(input(postToolUse("Write", { file_path: "/project/dist/output.js", content: "bundled" }, { success: true })));
    expect(result.significance).toBe("medium");
    expect(result.rule).toBe("default");
  });

  test("Write to project root file (no subdirectory) IS critical", () => {
    const result = classify(input(postToolUse("Write", { file_path: "/project/Dockerfile", content: "FROM node:20" }, { success: true })));
    expect(result.significance).toBe("critical");
    expect(result.rule).toBe("new_source_file");
  });

  // --- credential false-positive guard ---

  test("src/secret-rotation.ts is NOT skipped as credential file", () => {
    const result = classify(input(postToolUse("Read", { file_path: "/project/src/secret-rotation.ts" }, { content: "..." })));
    expect(result.significance).not.toBe("skip");
  });

  // --- SessionStart / Stop ---

  test("SessionStart is SKIP (lifecycle event, not stored)", () => {
    const payload: HookPayload = { type: "SessionStart", session_id: "s1", cwd: "/project", trigger: "startup" };
    const result = classify(input(payload));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("session_lifecycle");
  });

  test("Stop is SKIP (lifecycle event, not stored)", () => {
    const payload: HookPayload = { type: "Stop", session_id: "s1", cwd: "/project" };
    const result = classify(input(payload));
    expect(result.significance).toBe("skip");
    expect(result.rule).toBe("session_lifecycle");
  });
});
