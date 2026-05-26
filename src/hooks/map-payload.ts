import type { HookPayload, HookType } from "../types";

const HOOK_EVENT_MAP: Record<string, HookType> = {
  SessionStart: "SessionStart",
  PostToolUse: "PostToolUse",
  UserPromptSubmit: "UserPromptSubmit",
  Stop: "Stop",
};

export function mapPayload(raw: Record<string, unknown>): HookPayload {
  const hookEvent = raw.hook_event_name as string;
  const type = HOOK_EVENT_MAP[hookEvent] ?? (hookEvent as HookType);

  const base: HookPayload = {
    type,
    session_id: raw.session_id as string,
    cwd: raw.cwd as string,
  };

  if (type === "SessionStart") {
    base.trigger = raw.source as string | undefined;
    return base;
  }

  if (type === "UserPromptSubmit") {
    base.prompt = raw.prompt as string;
    return base;
  }

  if (type === "PostToolUse") {
    base.tool = raw.tool_name as string;
    base.input = raw.tool_input;
    base.output = raw.tool_output ?? raw.tool_response;
    return base;
  }

  return base;
}
