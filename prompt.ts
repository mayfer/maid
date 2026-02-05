import { arch, platform } from "os";

const RUNTIME_CONTEXT_PREFIX = "Runtime context:";
export const DEFAULT_CHAT_SYSTEM_PROMPT = "You are a terminal assistant for quick, concise answers. Provide only what the user asked for. No extra context, no markdown, plain text only. If and only if the entire answer is exactly one executable shell command, output exactly one XML tag and nothing else: <command>YOUR_COMMAND_HERE</command>. Never emit <command> for non-command answers.";

export function buildPrompt(systemPrompt: string): string {
  const osInfo = `${platform()}/${arch()}`;
  const today = new Date().toISOString().slice(0, 10);
  const runtimeLine = `${RUNTIME_CONTEXT_PREFIX} OS=${osInfo}. Today=${today}.`;
  const trimmed = systemPrompt.trim();
  if (!trimmed) return runtimeLine;
  if (trimmed.includes(RUNTIME_CONTEXT_PREFIX)) return trimmed;
  return `${trimmed}\n${runtimeLine}`;
}
