import { randomBytes } from "node:crypto";
import { positiveInt } from "../documents/limits";
import { envModelId } from "../flows/ingest-document/limits";
import { StartupConfigError } from "../startupError";

export const CHAT_EFFORTS = ["low", "medium", "high", "max"] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];

export interface ChatSettings {
  model: string;
  effort: ChatEffort;
  maxTokens: number;
  contextTokens: number;
  hops: 0 | 1 | 2;
  generalKnowledge: boolean;
  titleModel: string;
  /** Signs the inbox envelopes (D11). Never logged, never returned in an error. */
  envelopeKey: string;
  previousKeys: readonly string[];
}

const MIN_KEY_CHARS = 32;
const MAX_KEY_CHARS = 512;
const MAX_PREVIOUS_KEYS = 4;

const blankToUndefined = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

function envelopeKeys(env: NodeJS.ProcessEnv): { envelopeKey: string; previousKeys: string[] } {
  const current = blankToUndefined(env.DOCMIND_CHAT_ENVELOPE_KEY);
  const previousRaw = blankToUndefined(env.DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS);
  const apiKey = blankToUndefined(env.ANTHROPIC_API_KEY);
  const valid = (k: string) => k.length >= MIN_KEY_CHARS && k.length <= MAX_KEY_CHARS;
  if (current !== undefined && !valid(current))
    throw new StartupConfigError(
      `DOCMIND_CHAT_ENVELOPE_KEY must be ${MIN_KEY_CHARS} to ${MAX_KEY_CHARS} characters`,
    );
  if (current === undefined && apiKey !== undefined)
    throw new StartupConfigError(
      "DOCMIND_CHAT_ENVELOPE_KEY is required when ANTHROPIC_API_KEY is set",
    );
  const previousKeys = (previousRaw ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  if (previousKeys.length > 0 && current === undefined)
    throw new StartupConfigError(
      "DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS needs DOCMIND_CHAT_ENVELOPE_KEY",
    );
  if (previousKeys.length > MAX_PREVIOUS_KEYS)
    throw new StartupConfigError(
      `DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS holds at most ${MAX_PREVIOUS_KEYS} keys`,
    );
  if (!previousKeys.every(valid))
    throw new StartupConfigError(
      `DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS entries must be ${MIN_KEY_CHARS} to ${MAX_KEY_CHARS} characters`,
    );
  // No API key means no chat: nothing can be sent, so a per-process key only lets the flows be built.
  return { envelopeKey: current ?? randomBytes(32).toString("hex"), previousKeys };
}

/** Chat settings from the environment; an invalid variable throws an error naming it, never its value. */
export function loadChatSettings(env: NodeJS.ProcessEnv = process.env): ChatSettings {
  const effort = blankToUndefined(env.DOCMIND_CHAT_EFFORT) ?? "medium";
  if (!(CHAT_EFFORTS as readonly string[]).includes(effort))
    throw new StartupConfigError(`DOCMIND_CHAT_EFFORT must be one of ${CHAT_EFFORTS.join(", ")}`);
  const hops = blankToUndefined(env.DOCMIND_RETRIEVAL_HOPS) ?? "1";
  if (!/^[012]$/.test(hops))
    throw new StartupConfigError("DOCMIND_RETRIEVAL_HOPS must be 0, 1 or 2");
  const gk = blankToUndefined(env.DOCMIND_CHAT_GENERAL_KNOWLEDGE) ?? "false";
  if (gk !== "true" && gk !== "false")
    throw new StartupConfigError("DOCMIND_CHAT_GENERAL_KNOWLEDGE must be true or false");
  const maxTokens = positiveInt(env, "DOCMIND_CHAT_MAX_TOKENS", 16_000, 64_000);
  const contextTokens = positiveInt(env, "DOCMIND_CHAT_CONTEXT_TOKENS", 150_000, 1_000_000);
  if (contextTokens < 2 * maxTokens)
    throw new StartupConfigError(
      "DOCMIND_CHAT_CONTEXT_TOKENS must be at least twice DOCMIND_CHAT_MAX_TOKENS",
    );
  return {
    model: envModelId(env, "DOCMIND_CHAT_MODEL", "claude-opus-5-5"),
    effort: effort as ChatEffort,
    maxTokens,
    contextTokens,
    hops: Number(hops) as 0 | 1 | 2,
    generalKnowledge: gk === "true",
    titleModel: envModelId(env, "DOCMIND_TITLE_MODEL", "claude-haiku-5-5"),
    ...envelopeKeys(env),
  };
}
