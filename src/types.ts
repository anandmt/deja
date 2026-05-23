export type Significance = "skip" | "low" | "medium" | "high" | "critical";

export type ObservationKind =
  | "file_read"
  | "file_edit"
  | "file_write"
  | "bash_cmd"
  | "decision"
  | "prompt";

export interface Observation {
  id: number;
  session_id: string;
  project: string;
  significance: Significance;
  kind: ObservationKind;
  title: string;
  content: string;
  facts: string[] | null;
  concepts: string[] | null;
  files_read: string[] | null;
  files_modified: string[] | null;
  raw_event: string;
  embedding: Uint8Array | null;
  created_at_epoch: number;
}

export interface Session {
  id: string;
  project: string;
  started_at_epoch: number;
  ended_at_epoch: number | null;
  summary: string | null;
  summary_embedding: Uint8Array | null;
}

export interface Settings {
  context_budget: number;
  tiers: {
    ast: boolean;
    vectors: boolean;
  };
  llm: {
    enabled: boolean;
    provider: string | null;
    model: string | null;
    base_url: string | null;
  };
  retention: string | null;
  cross_project: boolean;
  log_level: LogLevel;
  log_max_days: number;
  excluded_projects: string[];
  debounce_ms: number;
  worker_idle_timeout_minutes: number;
  tcp_port: number;
}

export type LogLevel = "error" | "warn" | "info" | "debug";

export type HookType =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PostToolUse"
  | "Stop";

export interface HookPayload {
  type: HookType;
  session_id: string;
  cwd: string;
  [key: string]: unknown;
}

export interface BatchAnnotation {
  batch_size: number;
  batch_index: number;
  multi_file_edit: boolean;
  unique_files: string[];
}

export interface NormalizedEvent {
  tool: string | null;
  files: string[];
  action: string;
  content_summary: string;
  raw_event: string;
}

export interface ExtractedObservation {
  kind: ObservationKind;
  title: string;
  content: string;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface StatRow {
  project: string;
  metric: string;
  value: number;
}

export interface ClassifyResult {
  significance: Significance;
  rule: string;
}

export interface ClassifyInput {
  payload: HookPayload;
  recentCommands: Set<string>;
  seenWritePaths: Set<string>;
  settings: Pick<Settings, "excluded_projects">;
  batch?: BatchAnnotation;
}
