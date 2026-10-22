import type { CallObserver } from "@docmind/llm-anthropic";
import type { LlmProvider } from "@loom/llm";
import { createRoleProvider } from "../llm/factory";
import { loadLlmRoles } from "../llm/roles";
import type { ChatSettings } from "./settings";

/** One request's bound (180 s; ruling P3). It covers the whole stream. The chat flow has no turn timer: this provider timeout is what bounds each attempt. */
export const CHAT_REQUEST_TIMEOUT_MS = 180_000;

export interface ChatLlm {
  provider: LlmProvider;
  /** Filled by `prepareChat` once the item store exists; read once per request. Only the Anthropic provider consults it. */
  observer: { current?: () => CallObserver | undefined };
}

/** The chat role's provider, or undefined when the role is off (D12). Keys live only inside the provider. */
export function createChatLlm(env: NodeJS.ProcessEnv, settings: ChatSettings): ChatLlm | undefined {
  const observer: ChatLlm["observer"] = {};
  const provider = createRoleProvider("chat", loadLlmRoles(env), env, {
    maxTokens: settings.maxTokens,
    timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
    chat: { effort: settings.effort, observer: () => observer.current?.() },
  });
  return provider && { provider, observer };
}
