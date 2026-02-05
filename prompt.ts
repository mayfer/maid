import { arch, platform } from "os";

const RUNTIME_CONTEXT_PREFIX = "Runtime context:";
export const DEFAULT_CHAT_SYSTEM_PROMPT = "You are a terminal assistant for quick, concise answers. Provide only what the user asked for. No extra context, no markdown, plain text only. If and only if the entire answer is exactly one executable shell command, output exactly two lines: line 1 is only the command; line 2 is only __RUN_COMMAND__. Never place __RUN_COMMAND__ anywhere else.";

export function buildPrompt(systemPrompt: string): string {
  const osInfo = `${platform()}/${arch()}`;
  const runtimeLine = `${RUNTIME_CONTEXT_PREFIX} OS=${osInfo}.`;
  const trimmed = systemPrompt.trim();
  if (!trimmed) return runtimeLine;
  if (trimmed.includes(RUNTIME_CONTEXT_PREFIX)) return trimmed;
  return `${trimmed}\n${runtimeLine}`;
}
