import { AnthropicMessagesProvider } from "@docmind/llm-anthropic";
import type { ChatSettings } from "../../chats/settings";

/** The small model that names chats: one short, non-streamed call, no thinking, no observer. Absent without a key. */
export function createTitleLlm(
  env: NodeJS.ProcessEnv,
  settings: ChatSettings,
): AnthropicMessagesProvider | undefined {
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  if (!apiKey) return undefined;
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim() || undefined;
  return new AnthropicMessagesProvider({
    apiKey,
    model: settings.titleModel,
    maxTokens: 256,
    timeoutMs: 30_000,
    ...(baseUrl && { baseUrl }),
  });
}
