import { AnthropicMessagesProvider, type CallObserver } from "@docmind/llm-anthropic";
import { GeminiProvider, type LlmCapabilities, type LlmProvider, OpenAiProvider } from "@loom/llm";
import type { ChatEffort } from "../chats/settings";
import { StartupConfigError } from "../startupError";
import { bounded } from "./bounded";
import type { LlmRole, LlmRoleSettings } from "./roles";

export interface RoleCallOptions {
  maxTokens: number;
  timeoutMs: number;
  /** Chat only: what the Claude and gemma providers do with it differs (D8). */
  chat?: { effort: ChatEffort; observer: () => CallObserver | undefined };
}

const OLLAMA_EFFORT = { low: "low", medium: "medium", high: "high", max: "high" } as const;
const OLLAMA_IMAGES: LlmCapabilities = { image: ["image/png", "image/jpeg", "image/webp"] };
const GEMINI_MEDIA: LlmCapabilities = {
  image: ["image/png", "image/jpeg", "image/webp"],
  file: ["application/pdf"],
};
/** The only Gemini model probed to accept a zero thinking budget (preflight G15); others can refuse it. */
const ZERO_BUDGET_MODEL = "gemini-3.5-flash";

/**
 * A base URL as `new URL(...).href` without trailing slashes, so `${base}/v1` is never `//v1`.
 * roles.ts has already proved it is an http(s) URL; a failure names the variable only.
 */
function normalise(url: string, name: string): string {
  try {
    return new URL(url).href.replace(/\/+$/, "");
  } catch {
    throw new StartupConfigError(`${name} must be an http(s) URL`);
  }
}

function anthropic(
  role: LlmRole,
  s: LlmRoleSettings,
  env: NodeJS.ProcessEnv,
  o: RoleCallOptions,
): LlmProvider {
  try {
    const inner = new AnthropicMessagesProvider({
      apiKey: env.ANTHROPIC_API_KEY?.trim() as string, // loadLlmRoles proved it is set
      model: s.roles[role].model,
      maxTokens: o.maxTokens,
      timeoutMs: o.timeoutMs,
      ...(s.anthropicBaseUrl && { baseUrl: normalise(s.anthropicBaseUrl, "ANTHROPIC_BASE_URL") }),
      ...(o.chat && {
        thinking: true,
        effort: o.chat.effort,
        cache: true,
        refusal: "report" as const,
        observer: o.chat.observer,
      }),
    });
    // Bounded like the others: 401 / 403 become LlmConfigError, and a request's maxTokens is capped at the role's.
    return bounded(inner, o);
  } catch (err) {
    // The provider's messages name an option, never a value; say which variable it came from.
    if (err instanceof TypeError && /^baseUrl/.test(err.message))
      throw new StartupConfigError(err.message.replace(/^baseUrl/, "ANTHROPIC_BASE_URL"));
    if (err instanceof TypeError && /^apiKey/.test(err.message))
      throw new StartupConfigError("ANTHROPIC_API_KEY must be a header-safe string");
    throw err;
  }
}

function ollama(role: LlmRole, s: LlmRoleSettings, o: RoleCallOptions): LlmProvider {
  let url: URL;
  try {
    url = new URL(s.ollamaUrl);
  } catch {
    throw new StartupConfigError("DOCMIND_OLLAMA_URL must be an http(s) URL");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new StartupConfigError("DOCMIND_OLLAMA_URL must be an http(s) URL without credentials");
  return bounded(
    new OpenAiProvider({
      baseUrl: normalise(url.href, "DOCMIND_OLLAMA_URL"),
      model: s.roles[role].model,
      apiKey: "", // never fall back to OPENAI_API_KEY: nothing secret goes to Ollama
      capabilities: { ...OLLAMA_IMAGES, ...(o.chat && { reasoning: true }) },
      ...(o.chat && { reasoningEffort: OLLAMA_EFFORT[o.chat.effort] }),
    }),
    o,
  );
}

function gemini(
  role: LlmRole,
  s: LlmRoleSettings,
  env: NodeJS.ProcessEnv,
  o: RoleCallOptions,
): LlmProvider {
  const apiKey = env.GEMINI_API_KEY?.trim() as string; // loadLlmRoles proved it is set
  const model = s.roles[role].model;
  // An explicit budget is honoured for any model; otherwise only the probed model gets the zero default.
  const explicit = env.DOCMIND_GEMINI_THINKING_BUDGET?.trim();
  const thinkingBudget = explicit
    ? s.geminiThinkingBudget
    : model === ZERO_BUDGET_MODEL
      ? s.geminiThinkingBudget
      : undefined;
  return bounded(
    new GeminiProvider({
      apiKey, // explicit: never GOOGLE_API_KEY
      model,
      ...(s.geminiBaseUrl && { baseUrl: normalise(s.geminiBaseUrl, "GEMINI_BASE_URL") }),
      capabilities: GEMINI_MEDIA,
      ...(thinkingBudget !== undefined && { thinkingBudget }),
    }),
    o,
  );
}

/** The provider a role is configured for, or undefined when it is off. Startup errors name variables only. */
export function createRoleProvider(
  role: LlmRole,
  s: LlmRoleSettings,
  env: NodeJS.ProcessEnv,
  o: RoleCallOptions,
): LlmProvider | undefined {
  switch (s.roles[role].provider) {
    case "off":
      return undefined;
    case "anthropic":
      return anthropic(role, s, env, o);
    case "ollama":
      return ollama(role, s, o);
    case "gemini":
      return gemini(role, s, env, o);
  }
}
