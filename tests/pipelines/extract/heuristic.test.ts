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
