import { AnthropicMessagesProvider, type CallObserver } from "@docmind/llm-anthropic";
import type { LlmProvider } from "@loom/llm";
import { StartupConfigError } from "../startupError";
import type { ChatSettings } from "./settings";

/** One request's bound (180 s; ruling P3). It covers the whole stream. The chat flow has no turn timer: this provider timeout is what bounds each attempt. */
export const CHAT_REQUEST_TIMEOUT_MS = 180_000;

export interface ChatLlm {
  provider: LlmProvider;
  /** Filled by `prepareChat` once the item store exists; read once per request. */
  observer: { current?: () => CallObserver | undefined };
}

/** The chat's Claude provider, or undefined without `ANTHROPIC_API_KEY` (D12). The key lives only inside the provider. */
export function createChatLlm(env: NodeJS.ProcessEnv, settings: ChatSettings): ChatLlm | undefined {
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  if (!apiKey) return undefined;
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const observer: ChatLlm["observer"] = {};
  try {
    const provider = new AnthropicMessagesProvider({
      apiKey,
      model: settings.model,
      maxTokens: settings.maxTokens,
      timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
      ...(baseUrl && { baseUrl }),
      thinking: true,
      effort: settings.effort,
      cache: true,
      refusal: "report",
      observer: () => observer.current?.(),
    });
    return { provider, observer };
  } catch (err) {
    // The provider's messages name an option, never a value; say which variable it came from.
    if (err instanceof TypeError && /^baseUrl/.test(err.message))
      throw new StartupConfigError(err.message.replace(/^baseUrl/, "ANTHROPIC_BASE_URL"));
    if (err instanceof TypeError && /^apiKey/.test(err.message))
      throw new StartupConfigError("ANTHROPIC_API_KEY must be a header-safe string");
    throw err;
  }
}
