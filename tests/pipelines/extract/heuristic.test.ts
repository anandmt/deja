import { describe, test, expect } from "bun:test";
import {
  normalizeConcept,
  extractConceptsFromPath,
  extractSymbols,
  capConcepts,
  extractHeuristic,
} from "../../../src/pipelines/extract/heuristic";
import type { NormalizedEvent, ClassifyResult } from "../../../src/types";

describe("normalizeConcept", () => {
  test("splits camelCase", () => {
    expect(normalizeConcept("connectionManager")).toBe("connection-manager");
  });

  test("splits PascalCase", () => {
    expect(normalizeConcept("ConnectionManager")).toBe("connection-manager");
  });

  test("splits consecutive uppercase (XMLParser)", () => {
    expect(normalizeConcept("XMLParser")).toBe("xml-parser");
  });

  test("collapses underscores to hyphens", () => {
    expect(normalizeConcept("Rate_Limiting")).toBe("rate-limiting");
  });

  test("already normalized passthrough", () => {
    expect(normalizeConcept("rate-limiting")).toBe("rate-limiting");
  });

  test("trims leading/trailing hyphens from dunder", () => {
    expect(normalizeConcept("__init__")).toBe("init");
  });
});

describe("extractConceptsFromPath", () => {
  test("extracts non-stopword segments", () => {
    expect(extractConceptsFromPath("src/tools/trading.py")).toEqual(["tools", "trading"]);
  });

  test("drops all stopwords and extensions", () => {
    expect(extractConceptsFromPath("src/index.ts")).toEqual([]);
  });

  test("extracts multiple meaningful segments", () => {
    expect(extractConceptsFromPath("src/services/auth/oauth-handler.ts")).toEqual([
      "services", "auth", "oauth-handler",
    ]);
  });

  test("normalizes segments with camelCase", () => {
    expect(extractConceptsFromPath("src/userAuth/sessionManager.ts")).toEqual([
      "user-auth", "session-manager",
    ]);
  });

  test("handles root-level files", () => {
    expect(extractConceptsFromPath("Dockerfile")).toEqual(["dockerfile"]);
  });
});

describe("extractSymbols", () => {
  test("detects JS/TS function declarations", () => {
    expect(extractSymbols("function handleAuth() {")).toContain("handleAuth");
  });

  test("detects async functions", () => {
    expect(extractSymbols("async function fetchData() {")).toContain("fetchData");
  });

  test("detects class declarations", () => {
    expect(extractSymbols("class ConnectionManager {")).toContain("ConnectionManager");
  });

  test("detects Python def", () => {
    expect(extractSymbols("def reconnect(self):")).toContain("reconnect");
  });

  test("detects Go func", () => {
    expect(extractSymbols("func HandleRequest(w http.ResponseWriter) {")).toContain("HandleRequest");
  });

  test("detects Rust fn", () => {
    expect(extractSymbols("pub fn process_event(ev: &Event) -> Result<()> {")).toContain("process_event");
  });

  test("detects export const", () => {
    expect(extractSymbols("export const API_TIMEOUT = 5000;")).toContain("API_TIMEOUT");
  });

  test("returns multiple symbols", () => {
    const text = "class Foo {\n  function bar() {}\n}";
    const symbols = extractSymbols(text);
    expect(symbols).toContain("Foo");
    expect(symbols).toContain("bar");
  });

  test("returns empty for no matches", () => {
    expect(extractSymbols("just some text")).toEqual([]);
  });
});

describe("capConcepts", () => {
  test("keeps all when under limit", () => {
    expect(capConcepts(["a", "bb", "ccc"], 5)).toEqual(["a", "bb", "ccc"]);
  });

  test("caps at max, keeping longest", () => {
    const input = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff", "ggggggg"];
    const result = capConcepts(input, 5);
    expect(result.length).toBe(5);
    expect(result).toContain("ggggggg");
    expect(result).toContain("ffffff");
    expect(result).not.toContain("a");
  });

  test("deduplicates", () => {
    expect(capConcepts(["auth", "auth", "config"], 5)).toEqual(["auth", "config"]);
  });
});

function makeNormalized(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    tool: null,
    files: [],
    action: "unknown",
    content_summary: "",
    raw_event: "{}",
    ...overrides,
  };
}

function makeClassify(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return { significance: "medium", rule: "default", ...overrides };
}

describe("extractHeuristic", () => {
  describe("Edit events", () => {
    test("extracts function name into title", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Edit",
          files: ["/project/src/connection.ts"],
          action: "edit",
          content_summary: "EDIT /project/src/connection.ts\n--- old\nfunction reconnect() { return false; }\n+++ new\nfunction reconnect() { return true; }",
        }),
        makeClassify(),
      );
      expect(result.kind).toBe("file_edit");
      expect(result.title).toContain("reconnect");
      expect(result.title).toContain("connection.ts");
      expect(result.files_modified).toEqual(["/project/src/connection.ts"]);
      expect(result.files_read).toEqual([]);
    });

    test("falls back to generic title without symbols", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Edit",
          files: ["/project/src/config.ts"],
          action: "edit",
          content_summary: "EDIT /project/src/config.ts\n--- old\ntimeout = 5000\n+++ new\ntimeout = 10000",
        }),
        makeClassify(),
      );
      expect(result.title).toBe("Edited config.ts");
    });

    test("extracts concepts from file path", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Edit",
          files: ["/project/src/services/auth/handler.ts"],
          action: "edit",
          content_summary: "EDIT /project/src/services/auth/handler.ts\n--- old\nx\n+++ new\ny",
        }),
        makeClassify(),
      );
      expect(result.concepts).toContain("services");
      expect(result.concepts).toContain("auth");
      expect(result.concepts).toContain("handler");
    });

    test("adds detected symbols as concepts", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Edit",
          files: ["/project/src/app.ts"],
          action: "edit",
          content_summary: "EDIT /project/src/app.ts\n--- old\n\n+++ new\nclass ConnectionManager {",
        }),
        makeClassify(),
      );
      expect(result.concepts).toContain("connection-manager");
    });
  });

  describe("Write events", () => {
    test("creates file_write observation with Created title", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Write",
          files: ["/project/src/new-module.ts"],
          action: "write",
          content_summary: "WRITE /project/src/new-module.ts\nexport class Foo {\n  bar() {}\n}",
        }),
        makeClassify({ significance: "critical", rule: "new_source_file" }),
      );
      expect(result.kind).toBe("file_write");
      expect(result.title).toBe("Created new-module.ts");
      expect(result.files_modified).toEqual(["/project/src/new-module.ts"]);
    });

    test("extracts symbols from written content", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Write",
          files: ["/project/src/handler.ts"],
          action: "write",
          content_summary: "WRITE /project/src/handler.ts\nexport function handleAuth() {}\nexport class AuthProvider {}",
        }),
        makeClassify(),
      );
      expect(result.facts).toContain("handleAuth");
      expect(result.facts).toContain("AuthProvider");
    });
  });

  describe("Read events", () => {
    test("creates file_read observation", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Read",
          files: ["/project/src/client.py"],
          action: "read",
          content_summary: "READ /project/src/client.py\nimport asyncio\n\nclass IBKRClient:\n    pass",
        }),
        makeClassify({ significance: "low", rule: "config_file_read" }),
      );
      expect(result.kind).toBe("file_read");
      expect(result.title).toBe("Read client.py");
      expect(result.files_read).toEqual(["/project/src/client.py"]);
      expect(result.files_modified).toEqual([]);
    });
  });

  describe("Bash events", () => {
    test("detects test runner with pass/fail counts", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Bash",
          action: "bash",
          content_summary: "BASH $ pytest tests/ -v\n42 passed, 3 failed",
        }),
        makeClassify({ significance: "high", rule: "test_failure" }),
      );
      expect(result.kind).toBe("bash_cmd");
      expect(result.title).toContain("42 passed");
      expect(result.title).toContain("3 failed");
      expect(result.title).toContain("pytest");
      expect(result.concepts).toContain("testing");
    });

    test("detects test runner success", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Bash",
          action: "bash",
          content_summary: "BASH $ bun test\n10 pass\n0 fail",
        }),
        makeClassify(),
      );
      expect(result.title).toContain("10 passed");
      expect(result.title).toContain("bun:test");
    });

    test("detects git commit", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Bash",
          action: "bash",
          content_summary: "BASH $ git commit -m \"feat: add auth\"\n[main abc1234] feat: add auth",
        }),
        makeClassify(),
      );
      expect(result.title).toContain("Git:");
      expect(result.title).toContain("feat: add auth");
      expect(result.concepts).toContain("git");
      expect(result.concepts).toContain("git-commit");
    });

    test("detects git checkout/switch", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Bash",
          action: "bash",
          content_summary: "BASH $ git checkout feature-branch\nSwitched to branch 'feature-branch'",
        }),
        makeClassify(),
      );
      expect(result.title).toContain("Git:");
      expect(result.title).toContain("feature-branch");
    });

    test("generic bash command title", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Bash",
          action: "bash",
          content_summary: "BASH $ npm run build\nCompiled successfully",
        }),
        makeClassify(),
      );
      expect(result.title).toBe("Ran: npm run build");
    });

    test("bash error includes exit indication", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Bash",
          action: "bash",
          content_summary: "BASH $ node server.js\nError: EADDRINUSE",
        }),
        makeClassify({ significance: "high", rule: "error_debugging" }),
      );
      expect(result.kind).toBe("bash_cmd");
      expect(result.title).toContain("Error:");
    });
  });

  describe("Prompt events", () => {
    test("CRITICAL decision → kind=decision, Decision title", () => {
      const result = extractHeuristic(
        makeNormalized({
          action: "prompt",
          content_summary: "PROMPT let's use Redis for caching instead of Memcached, it has better pub/sub support",
        }),
        makeClassify({ significance: "critical", rule: "decision_prompt" }),
      );
      expect(result.kind).toBe("decision");
      expect(result.title).toMatch(/^Decision: /);
      expect(result.title).toContain("Redis");
      expect(result.title.length).toBeLessThanOrEqual(90); // "Decision: " (10) + 80
    });

    test("non-decision prompt → kind=prompt, Prompt title", () => {
      const result = extractHeuristic(
        makeNormalized({
          action: "prompt",
          content_summary: "PROMPT fix the rate limiting bug in client.py",
        }),
        makeClassify(),
      );
      expect(result.kind).toBe("prompt");
      expect(result.title).toMatch(/^Prompt: /);
      expect(result.title).toContain("rate limiting");
    });
  });

  describe("empty files edge case", () => {
    test("edit with no file uses 'unknown' in title", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Edit",
          files: [],
          action: "edit",
          content_summary: "EDIT \n--- old\nfoo\n+++ new\nbar",
        }),
        makeClassify(),
      );
      expect(result.title).toBe("Edited unknown");
    });
  });

  describe("concept cap", () => {
    test("caps concepts at 5", () => {
      const result = extractHeuristic(
        makeNormalized({
          tool: "Edit",
          files: ["/project/src/services/auth/oauth/token/refresh/handler.ts"],
          action: "edit",
          content_summary: "EDIT /project/src/services/auth/oauth/token/refresh/handler.ts\n--- old\nclass TokenRefreshHandler {}\n+++ new\nclass TokenRefreshHandler { refresh() {} }",
        }),
        makeClassify(),
      );
      expect(result.concepts.length).toBeLessThanOrEqual(5);
    });
  });
});
