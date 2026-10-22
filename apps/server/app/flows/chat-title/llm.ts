import type { LlmProvider } from "@loom/llm";
import type { ChatSettings } from "../../chats/settings";
import { createRoleProvider } from "../../llm/factory";
import { loadLlmRoles } from "../../llm/roles";

/** The small model that names chats: one short, non-streamed call, no thinking, no observer. Absent when the role is off. */
export function createTitleLlm(
  env: NodeJS.ProcessEnv,
  _settings: ChatSettings,
): LlmProvider | undefined {
  return createRoleProvider("title", loadLlmRoles(env), env, { maxTokens: 256, timeoutMs: 30_000 });
}
