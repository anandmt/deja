import type { NormalizedEvent, ClassifyResult, ExtractedObservation } from "../../types";

const PATH_STOPWORDS = new Set([
  "src", "lib", "app", "dist", "build", "index", "main",
  "test", "tests", "spec", "__pycache__", "node_modules",
]);

const FILE_EXTENSIONS = new Set([
  "py", "ts", "tsx", "js", "jsx", "go", "rs", "java",
  "rb", "c", "cpp", "h", "hpp", "cs", "swift", "kt",
  "vue", "svelte", "astro", "md", "json", "yaml", "yml",
  "toml", "cfg", "ini", "sh", "bash", "zsh",
]);

export function normalizeConcept(raw: string): string {
  return raw
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function extractConceptsFromPath(filePath: string): string[] {
  const segments = filePath.split(/[/\\.]/).filter((s) => s.length > 0);
  return segments
    .filter((s) => !PATH_STOPWORDS.has(s) && !FILE_EXTENSIONS.has(s))
    .map(normalizeConcept)
    .filter((s) => s.length > 0);
}

const SYMBOL_PATTERNS = [
  /(?:^|\n)\s*def\s+(\w+)/g,
  /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/g,
  /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)/g,
  /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+(\w+)/g,
  /(?:^|\n)\s*func\s+(\w+)/g,
  /(?:^|\n)\s*(?:pub\s+)?fn\s+(\w+)/g,
];

export function extractSymbols(text: string): string[] {
  const symbols: string[] = [];
  for (const pattern of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      symbols.push(match[1]);
    }
  }
  return [...new Set(symbols)];
}

export function capConcepts(concepts: string[], max: number = 5): string[] {
  const unique = [...new Set(concepts)];
  if (unique.length <= max) return unique;
  return unique.sort((a, b) => b.length - a.length).slice(0, max);
}

function basename(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? filePath : filePath.slice(i + 1);
}

function parseBashCommand(contentSummary: string): { command: string; output: string } {
  const firstNewline = contentSummary.indexOf("\n");
  if (firstNewline === -1) return { command: contentSummary.slice(7), output: "" };
  return {
    command: contentSummary.slice(7, firstNewline),
    output: contentSummary.slice(firstNewline + 1),
  };
}

const TEST_RUNNERS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /pytest/, name: "pytest" },
  { pattern: /jest/, name: "jest" },
  { pattern: /vitest/, name: "vitest" },
  { pattern: /bun test/, name: "bun:test" },
  { pattern: /cargo test/, name: "cargo" },
  { pattern: /go test/, name: "go" },
  { pattern: /npm test/, name: "npm" },
];

function extractBashConcepts(command: string): string[] {
  const concepts: string[] = [];
  if (TEST_RUNNERS.some((r) => r.pattern.test(command))) {
    concepts.push("testing");
  }
  const gitMatch = command.match(/^git\s+(\w+)/);
  if (gitMatch) {
    concepts.push("git", `git-${gitMatch[1]}`);
  }
  if (/npm run build|cargo build|make\b|webpack|vite build/.test(command)) {
    concepts.push("build");
  }
  return concepts;
}

function extractBashTitle(command: string, output: string, isFailed: boolean): string {
  for (const runner of TEST_RUNNERS) {
    if (runner.pattern.test(command)) {
      const passMatch = output.match(/(\d+)\s*pass/i);
      const failMatch = output.match(/(\d+)\s*fail/i);
      const parts: string[] = [];
      if (passMatch) parts.push(`${passMatch[1]} passed`);
      if (failMatch) parts.push(`${failMatch[1]} failed`);
      if (parts.length > 0) return `Tests: ${parts.join(", ")} (${runner.name})`;
      return isFailed ? `Tests: failed (${runner.name})` : `Tests: passed (${runner.name})`;
    }
  }

  const gitMatch = command.match(/^git\s+(\w+)/);
  if (gitMatch) {
    const sub = gitMatch[1];
    if (sub === "commit") {
      const msgMatch = command.match(/-m\s+["']([^"']+)["']/);
      return msgMatch ? `Git: commit "${msgMatch[1].slice(0, 60)}"` : "Git: commit";
    }
    if (sub === "checkout" || sub === "switch") {
      const branchMatch = command.match(/(?:checkout|switch)\s+(?:-[bB]\s+)?(\S+)/);
      return branchMatch ? `Git: ${sub} ${branchMatch[1]}` : `Git: ${sub}`;
    }
    return `Git: ${sub}`;
  }

  if (isFailed) return `Error: ${command.slice(0, 70)}`;
  return `Ran: ${command.slice(0, 80)}`;
}

export function extractHeuristic(
  normalized: NormalizedEvent,
  classify: ClassifyResult,
): ExtractedObservation {
  const file = normalized.files[0] ?? "";
  const name = file ? basename(file) : "";
  const content = normalized.content_summary;

  // --- Edit ---
  if (normalized.action === "edit") {
    const symbols = extractSymbols(content);
    const pathConcepts = file ? extractConceptsFromPath(file) : [];
    const symbolConcepts = symbols.map(normalizeConcept);
    const label = name || "unknown";
    const title = symbols.length > 0
      ? `Modified ${symbols[0]}() in ${label}`
      : `Edited ${label}`;
    return {
      kind: "file_edit",
      title,
      content,
      facts: symbols,
      concepts: capConcepts([...pathConcepts, ...symbolConcepts]),
      files_read: [],
      files_modified: normalized.files,
    };
  }

  // --- Write ---
  if (normalized.action === "write") {
    const symbols = extractSymbols(content);
    const pathConcepts = file ? extractConceptsFromPath(file) : [];
    const symbolConcepts = symbols.map(normalizeConcept);
    return {
      kind: "file_write",
      title: `Created ${name || "unknown"}`,
      content,
      facts: symbols,
      concepts: capConcepts([...pathConcepts, ...symbolConcepts]),
      files_read: [],
      files_modified: normalized.files,
    };
  }

  // --- Read ---
  if (normalized.action === "read") {
    const pathConcepts = file ? extractConceptsFromPath(file) : [];
    return {
      kind: "file_read",
      title: `Read ${name || "unknown"}`,
      content,
      facts: [],
      concepts: capConcepts(pathConcepts),
      files_read: normalized.files,
      files_modified: [],
    };
  }

  // --- Bash ---
  if (normalized.action === "bash") {
    const { command, output } = parseBashCommand(content);
    const isFailed = classify.rule === "test_failure" || classify.rule === "error_debugging";
    const title = extractBashTitle(command, output, isFailed);
    const concepts = extractBashConcepts(command);
    if (isFailed && TEST_RUNNERS.some((r) => r.pattern.test(command))) {
      concepts.push("failure");
    }
    return {
      kind: "bash_cmd",
      title,
      content,
      facts: [],
      concepts: capConcepts(concepts),
      files_read: [],
      files_modified: [],
    };
  }

  // --- Prompt ---
  if (normalized.action === "prompt") {
    const promptText = content.startsWith("PROMPT ") ? content.slice(7) : content;
    const isDecision = classify.significance === "critical" && classify.rule === "decision_prompt";
    const prefix = isDecision ? "Decision" : "Prompt";
    return {
      kind: isDecision ? "decision" : "prompt",
      title: `${prefix}: ${promptText.slice(0, 80)}`,
      content,
      facts: [],
      concepts: [],
      files_read: [],
      files_modified: [],
    };
  }

  // --- Fallback ---
  return {
    kind: "prompt",
    title: `Event: ${normalized.action}`,
    content,
    facts: [],
    concepts: [],
    files_read: [],
    files_modified: [],
  };
}
