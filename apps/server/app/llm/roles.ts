import { StartupConfigError } from "../startupError";
import { envModelId } from "./modelId";

export const LLM_ROLES = ["chat", "title", "summary", "vision", "visionPdf"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];
export const PROVIDERS = ["anthropic", "ollama", "gemini"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export type RoleProvider = ProviderName | "off";

export interface RoleSetting {
  provider: RoleProvider;
  /** "" when the role is off. */
  model: string;
}

export interface LlmRoleSettings {
  roles: Record<LlmRole, RoleSetting>;
  anthropicBaseUrl?: string;
  ollamaUrl: string;
  geminiBaseUrl?: string;
  geminiThinkingBudget: number;
}

const PREFIX: Record<LlmRole, string> = {
  chat: "DOCMIND_CHAT",
  title: "DOCMIND_TITLE",
  summary: "DOCMIND_SUMMARY",
  vision: "DOCMIND_VISION",
  visionPdf: "DOCMIND_VISION_PDF",
};

const MIB = 1024 * 1024;
/** What each provider can do. `pdfMaxBytes` is the provider's request limit for one inline PDF (D9). */
const CAN: Record<ProviderName, { stream: boolean; pdfMaxBytes: number }> = {
  anthropic: { stream: true, pdfMaxBytes: 22 * MIB },
  ollama: { stream: true, pdfMaxBytes: 0 },
  gemini: { stream: false, pdfMaxBytes: 14 * MIB },
};
export const pdfMaxBytes = (provider: ProviderName): number => CAN[provider].pdfMaxBytes;

const DEFAULT_MODEL: Record<ProviderName, Record<LlmRole, string>> = {
  anthropic: {
    chat: "claude-opus-5-5",
    title: "claude-haiku-5-5",
    summary: "claude-haiku-5-5",
    vision: "claude-sonnet-5-5",
    visionPdf: "claude-sonnet-5-5",
  },
  ollama: Object.fromEntries(LLM_ROLES.map((r) => [r, "gemma4:31b-cloud"])) as Record<
    LlmRole,
    string
  >,
  gemini: Object.fromEntries(LLM_ROLES.map((r) => [r, "gemini-3.5-flash"])) as Record<
    LlmRole,
    string
  >,
};

const blank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

function providerVar(env: NodeJS.ProcessEnv, name: string): RoleProvider | undefined {
  const v = blank(env[name])?.toLowerCase();
  if (v === undefined) return undefined;
  if (v === "off" || (PROVIDERS as readonly string[]).includes(v)) return v as RoleProvider;
  throw new StartupConfigError(`${name} must be one of ${PROVIDERS.join(", ")}, off`);
}

/** An http(s) URL with no credentials, query or fragment; throws naming the variable only. */
function baseUrl(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = blank(env[name]);
  if (raw === undefined) return undefined;
  let ok = false;
  try {
    const u = new URL(raw);
    ok =
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.username === "" &&
      u.password === "" &&
      u.search === "" &&
      u.hash === "" &&
      !raw.includes("?") &&
      !raw.includes("#");
  } catch {
    ok = false;
  }
  if (!ok)
    throw new StartupConfigError(
      `${name} must be an http or https URL without credentials, query or fragment`,
    );
  return raw;
}

function budget(env: NodeJS.ProcessEnv): number {
  const raw = blank(env.DOCMIND_GEMINI_THINKING_BUDGET);
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n > 24_576)
    throw new StartupConfigError(
      "DOCMIND_GEMINI_THINKING_BUDGET must be a whole number from 0 to 24576",
    );
  return n;
}

/**
 * Provider and model per role from the environment (D1 to D4). Throws a StartupConfigError that names
 * variables and never values. Pure: safe to call from every composition step.
 */
export function loadLlmRoles(env: NodeJS.ProcessEnv = process.env): LlmRoleSettings {
  const shared = providerVar(env, "DOCMIND_LLM_PROVIDER");
  const geminiKeyValue = blank(env.GEMINI_API_KEY);
  if (geminiKeyValue !== undefined && !/^[\x21-\x7e]+$/.test(geminiKeyValue))
    throw new StartupConfigError("GEMINI_API_KEY must be a plain ASCII header value");
  const geminiKey = geminiKeyValue !== undefined;
  const anthropicKey = blank(env.ANTHROPIC_API_KEY) !== undefined;
  const roles = {} as Record<LlmRole, RoleSetting>;
  for (const role of LLM_ROLES) {
    const providerName = `${PREFIX[role]}_PROVIDER`;
    const modelName = `${PREFIX[role]}_MODEL`;
    let provider: RoleProvider | undefined = providerVar(env, providerName);
    // The variable that set the provider, so a refusal names the one the operator must change.
    let source = providerName;
    if (provider === undefined) {
      if (role !== "visionPdf" && shared !== undefined) source = "DOCMIND_LLM_PROVIDER";
      if (role === "visionPdf") {
        // Only a provider that can read a PDF may be the default for it.
        if (shared !== undefined && shared !== "off" && CAN[shared].pdfMaxBytes > 0)
          source = "DOCMIND_LLM_PROVIDER";
        provider =
          shared === "off"
            ? "off"
            : shared !== undefined && CAN[shared].pdfMaxBytes > 0
              ? shared
              : geminiKey
                ? "gemini"
                : "off";
      } else provider = shared ?? "ollama";
    }
    if (provider === "off") {
      roles[role] = { provider, model: "" };
      continue;
    }
    if (role === "chat" && !CAN[provider].stream)
      throw new StartupConfigError(`${source} cannot be ${provider}: the chat needs streaming`);
    if (role === "visionPdf" && CAN[provider].pdfMaxBytes === 0)
      throw new StartupConfigError(`${providerName} cannot be ${provider}: it takes no PDF input`);
    if (provider === "anthropic" && !anthropicKey)
      throw new StartupConfigError(`ANTHROPIC_API_KEY is not set (${source}=anthropic)`);
    if (provider === "gemini" && !geminiKey)
      throw new StartupConfigError(`GEMINI_API_KEY is not set (${source}=gemini)`);
    // The PDF role inherits the image role's model variable when both use the same provider (it was one variable).
    const inherited =
      role === "visionPdf" && roles.vision.provider === provider
        ? blank(env.DOCMIND_VISION_MODEL)
        : undefined;
    const model = envModelId(env, modelName, inherited ?? DEFAULT_MODEL[provider][role]);
    // A leftover from a Claude-only .env: Ollama and Gemini would answer 404 for every request.
    if (model.startsWith("claude-") && provider !== "anthropic")
      throw new StartupConfigError(
        `${inherited !== undefined ? "DOCMIND_VISION_MODEL" : modelName} names a Claude model but ${source} is ${provider}`,
      );
    roles[role] = { provider, model };
  }
  const anthropicBaseUrl = baseUrl(env, "ANTHROPIC_BASE_URL");
  const geminiBaseUrl = baseUrl(env, "GEMINI_BASE_URL");
  return {
    roles,
    ...(anthropicBaseUrl && { anthropicBaseUrl }),
    ollamaUrl: baseUrl(env, "DOCMIND_OLLAMA_URL") ?? "http://127.0.0.1:11434",
    ...(geminiBaseUrl && { geminiBaseUrl }),
    geminiThinkingBudget: budget(env),
  };
}

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * A fixed warning (names the variable, never the address) when `url` is plain http:// to a host other than
 * this machine. Silent for https, loopback and anything that is not a URL (the provider rejects that itself).
 */
export function insecureUrlWarning(
  varName: string,
  url: string | undefined,
  what = "the API key and document text",
): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" || LOOPBACK_HOST.test(parsed.hostname)) return undefined;
  return `${varName} is plain http:// to a host that is not this machine: ${what} travel unencrypted`;
}

/** Boot warnings, fixed text, once per process. A URL is checked when a role uses its provider; the Ollama one always, for embeddings. */
export function llmWarnings(s: LlmRoleSettings, env: NodeJS.ProcessEnv = process.env): string[] {
  const used = new Set(LLM_ROLES.map((r) => s.roles[r].provider));
  const out: string[] = [];
  if (blank(env.ANTHROPIC_API_KEY) !== undefined && !used.has("anthropic"))
    out.push("ANTHROPIC_API_KEY is set but no role uses the anthropic provider");
  if (s.roles.chat.provider !== "off" && blank(env.DOCMIND_CHAT_ENVELOPE_KEY) === undefined)
    out.push("DOCMIND_CHAT_ENVELOPE_KEY is not set: chat envelopes do not survive a restart");
  const urls: [ProviderName, string, string | undefined, string?][] = [
    ["anthropic", "ANTHROPIC_BASE_URL", s.anthropicBaseUrl],
    ["ollama", "DOCMIND_OLLAMA_URL", s.ollamaUrl, "document text and questions"],
    ["gemini", "GEMINI_BASE_URL", s.geminiBaseUrl],
  ];
  for (const [p, name, url, what] of urls) {
    // Embeddings always go to Ollama, whatever the roles use.
    const w = used.has(p) || p === "ollama" ? insecureUrlWarning(name, url, what) : undefined;
    if (w) out.push(w);
  }
  const off: [LlmRole, string][] = [
    ["chat", "chat is off: DOCMIND_CHAT_PROVIDER is off"],
    ["title", "chat titles are off: DOCMIND_TITLE_PROVIDER is off"],
    ["summary", "summaries are off: DOCMIND_SUMMARY_PROVIDER is off"],
    ["vision", "image reading is off: DOCMIND_VISION_PROVIDER is off"],
    ["visionPdf", "scanned PDF pages are not read: DOCMIND_VISION_PDF_PROVIDER is off"],
  ];
  for (const [role, text] of off) if (s.roles[role].provider === "off") out.push(text);
  return out;
}
