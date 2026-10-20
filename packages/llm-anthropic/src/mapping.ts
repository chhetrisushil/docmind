import type { LlmUsageDetail, RefusalDetails } from "./observer";

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
