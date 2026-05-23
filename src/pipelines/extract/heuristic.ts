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
  /(?:^|\n)\s*(?:async\s+)?function\s+(\w+)/g,
  /(?:^|\n)\s*class\s+(\w+)/g,
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

// Placeholder — implemented in Task 4
export function extractHeuristic(
  _normalized: NormalizedEvent,
  _classify: ClassifyResult,
): ExtractedObservation {
  throw new Error("Not implemented yet");
}
