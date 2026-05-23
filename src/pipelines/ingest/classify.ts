import type { ClassifyInput, ClassifyResult } from "../../types";

const NOISE_PATH_PATTERNS = [
  /node_modules\//,
  /\.git\//,
  /-lock\.json$/,
  /\.lock$/,
  /dist\//,
  /build\//,
  /\.next\//,
];

const NOISE_EXTENSIONS = [/\.map$/, /\.min\.js$/, /\.min\.css$/];

const NAV_COMMANDS = /^(ls|pwd|cd|echo \$|which|type|cat <<<)/;

const CREDENTIAL_PATTERNS = [
  /\.env($|\.)/,
  /\.pem$/,
  /\.key$/,
  /credentials\./,
  /[\\/]\.?secrets?\./,
];

const DEPENDENCY_FILES = new Set([
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "requirements.txt",
  "Gemfile",
]);

const DECISION_PATTERNS = /\b(let'?s use|switch to|we should|decided to|choosing|going with)\b/i;

const TEST_COMMANDS = /pytest|jest|vitest|cargo test|go test|npm test|bun test/;

const SEARCH_COMMANDS = /^(grep|find|rg|ag|fd) /;

const SOURCE_DIRS = /\/(src|lib|app)\//;

const CONFIG_EXTENSIONS = /\.(json|yaml|yml|toml|ini|cfg)$/;

function basename(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? filePath : filePath.slice(i + 1);
}

export function classify(input: ClassifyInput, now: number = Date.now()): ClassifyResult {
  const { payload, recentCommands, seenWritePaths, settings, batch } = input;
  const tool = (payload as any).tool as string | undefined;
  const filePath = ((payload as any).input?.file_path ?? "") as string;
  const command = ((payload as any).input?.command ?? "") as string;
  const stdout = ((payload as any).output?.stdout ?? "") as string;
  const stderr = ((payload as any).output?.stderr ?? "") as string;
  const exitCode = ((payload as any).output?.exit_code ?? 0) as number;
  const prompt = ((payload as any).prompt ?? "") as string;

  if (payload.type === "SessionStart" || payload.type === "Stop") {
    return { significance: "skip", rule: "session_lifecycle" };
  }

  if (settings.excluded_projects.some((p) => payload.cwd.startsWith(p))) {
    return { significance: "skip", rule: "excluded_project" };
  }

  if (tool === "Read" && NOISE_PATH_PATTERNS.some((p) => p.test(filePath))) {
    return { significance: "skip", rule: "noise_file_read" };
  }

  if (tool === "Read" && NOISE_EXTENSIONS.some((p) => p.test(filePath))) {
    return { significance: "skip", rule: "noise_file_extension" };
  }

  if (tool === "Bash" && command) {
    for (const entry of recentCommands) {
      const sep = entry.lastIndexOf(":");
      const cmd = entry.slice(0, sep);
      const ts = parseInt(entry.slice(sep + 1), 10);
      if (cmd === command && now - ts < 60_000) {
        return { significance: "skip", rule: "duplicate_bash" };
      }
    }
  }

  if (tool === "Bash" && NAV_COMMANDS.test(command)) {
    return { significance: "skip", rule: "navigation_command" };
  }

  if (filePath && CREDENTIAL_PATTERNS.some((p) => p.test(filePath))) {
    return { significance: "skip", rule: "credential_file" };
  }

  if (tool === "Write" && !seenWritePaths.has(filePath)) {
    const isSourceDir = SOURCE_DIRS.test(filePath);
    const relPath = filePath.startsWith(payload.cwd + "/") ? filePath.slice(payload.cwd.length + 1) : "";
    const isProjectRootFile = relPath !== "" && !relPath.includes("/");
    if (isSourceDir || isProjectRootFile) {
      return { significance: "critical", rule: "new_source_file" };
    }
  }

  if (tool === "Edit" && DEPENDENCY_FILES.has(basename(filePath))) {
    return { significance: "critical", rule: "dependency_file_changed" };
  }

  if (payload.type === "UserPromptSubmit" && DECISION_PATTERNS.test(prompt)) {
    return { significance: "critical", rule: "decision_prompt" };
  }

  if (batch?.multi_file_edit) {
    return { significance: "high", rule: "multi_file_edit" };
  }

  if (
    tool === "Bash" &&
    exitCode !== 0 &&
    (TEST_COMMANDS.test(command) || /failed|FAIL|error/i.test(stdout))
  ) {
    return { significance: "high", rule: "test_failure" };
  }

  if (tool === "Bash" && exitCode !== 0 && stderr.length > 200) {
    return { significance: "high", rule: "error_debugging" };
  }

  if (tool === "Read" && CONFIG_EXTENSIONS.test(filePath)) {
    return { significance: "low", rule: "config_file_read" };
  }

  if (tool === "Bash" && SEARCH_COMMANDS.test(command) && stdout.length < 500) {
    return { significance: "low", rule: "simple_grep" };
  }

  return { significance: "medium", rule: "default" };
}
