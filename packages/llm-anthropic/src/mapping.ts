import { LlmRequestError } from "./errors";
import type { LlmUsageDetail, ReasoningBlock, RefusalDetails } from "./observer";

export const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0;

export type StopReason = "end_turn" | "tool_use" | "max_tokens";

/** Anything that is not a tool call or a truncation ends the turn. A refusal is handled by the caller. */
export function mapStopReason(raw: unknown): StopReason {
  if (raw === "tool_use") return "tool_use";
  if (raw === "max_tokens" || raw === "model_context_window_exceeded") return "max_tokens";
  return "end_turn";
}

const MAX_DETAIL = 2_000;
const short = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v.slice(0, MAX_DETAIL) : undefined;

/** `stop_details` of a refusal, strings only. The model's own words: the app seals them. */
export function refusalDetailsOf(raw: unknown): RefusalDetails {
  if (typeof raw !== "object" || raw === null) return {};
  const { category, explanation } = raw as Record<string, unknown>;
  const c = short(category);
  const e = short(explanation);
  return { ...(c !== undefined && { category: c }), ...(e !== undefined && { explanation: e }) };
}

export interface UsageFields {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** The count fields the API reported (a missing, null or malformed field is not reported). */
export function usageFieldsOf(raw: unknown): UsageFields {
  if (typeof raw !== "object" || raw === null) return {};
  const u = raw as Record<string, unknown>;
  const input = u.input_tokens;
  const output = u.output_tokens;
  const cacheRead = u.cache_read_input_tokens;
  const cacheWrite = u.cache_creation_input_tokens;
  return {
    ...(isCount(input) && { input }),
    ...(isCount(output) && { output }),
    ...(isCount(cacheRead) && { cacheRead }),
    ...(isCount(cacheWrite) && { cacheWrite }),
  };
}

export const usageDetail = (f: UsageFields): LlmUsageDetail => ({
  inputTokens: f.input ?? 0,
  outputTokens: f.output ?? 0,
  cacheReadTokens: f.cacheRead ?? 0,
  cacheWriteTokens: f.cacheWrite ?? 0,
});

export const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * The one rule set for a finished content block, shared by complete() and stream() so they cannot drift.
 * Returns the block to keep (verbatim, `tool_use` with `input` defaulted to `{}`), or undefined for a block
 * that is not kept (an empty text block, or an unknown type such as a server tool block).
 * Throws LlmRequestError (no values) for a malformed block.
 */
export function toContentBlock(b: Record<string, unknown>): ReasoningBlock | undefined {
  switch (b.type) {
    case "text":
      if (b.text !== undefined && typeof b.text !== "string") throw new LlmRequestError();
      return b.text === undefined || b.text === "" ? undefined : { ...b, type: "text" };
    case "tool_use":
      if (typeof b.id !== "string" || typeof b.name !== "string") throw new LlmRequestError();
      return { ...b, type: "tool_use", input: b.input ?? {} };
    case "thinking":
      if (typeof b.thinking !== "string" || typeof b.signature !== "string" || b.signature === "") {
        throw new LlmRequestError();
      }
      return { ...b, type: "thinking" };
    case "redacted_thinking":
      if (typeof b.data !== "string") throw new LlmRequestError();
      return { ...b, type: "redacted_thinking" };
    default:
      return undefined;
  }
}
