import type { LlmToolCall } from "@loom/llm";
import { LlmRequestError } from "./errors";
import { type UsageFields, isCount, usageFieldsOf } from "./mapping";
import type { ReasoningBlock } from "./observer";

export interface Parsed {
  /** The text blocks, joined. */
  text: string;
  toolCalls: LlmToolCall[];
  /** The response's content blocks (thinking, redacted_thinking, non-empty text, tool_use), verbatim, in the order the API returned them. */
  blocks: ReasoningBlock[];
  /** True when a `thinking` or `redacted_thinking` block was present. */
  sawThinking: boolean;
  /** The thinking text of each `thinking` block (summarized when so requested). */
  thinking: string[];
  stopReason: string;
  stopDetails: unknown;
  usage?: UsageFields;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const optionalCount = (v: unknown): boolean => v === undefined || v === null || isCount(v);

/** Validates the response by hand. Never puts the text in an error. */
export function parseResponse(raw: string): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LlmRequestError();
  }
  const o = obj(json);
  if (!o) throw new LlmRequestError();
  const { content, stop_reason: stop, stop_details: stopDetails, usage } = o;
  if (!Array.isArray(content) || typeof stop !== "string") throw new LlmRequestError();
  const out: Parsed = {
    text: "",
    toolCalls: [],
    blocks: [],
    sawThinking: false,
    thinking: [],
    stopReason: stop,
    stopDetails,
  };
  for (const item of content) {
    const b = obj(item);
    if (!b || typeof b.type !== "string") throw new LlmRequestError();
    if (b.type === "text") {
      if (b.text !== undefined && typeof b.text !== "string") throw new LlmRequestError();
      out.text += b.text ?? "";
      if (typeof b.text === "string" && b.text !== "") out.blocks.push({ ...b, type: "text" });
    } else if (b.type === "tool_use") {
      if (typeof b.id !== "string" || typeof b.name !== "string") throw new LlmRequestError();
      out.toolCalls.push({ id: b.id, name: b.name, input: b.input ?? {} });
      out.blocks.push({ ...b, type: "tool_use" });
    } else if (b.type === "thinking") {
      if (typeof b.thinking !== "string" || typeof b.signature !== "string") {
        throw new LlmRequestError();
      }
      out.blocks.push({ ...b, type: "thinking" });
      out.sawThinking = true;
      out.thinking.push(b.thinking);
    } else if (b.type === "redacted_thinking") {
      if (typeof b.data !== "string") throw new LlmRequestError();
      out.blocks.push({ ...b, type: "redacted_thinking" });
      out.sawThinking = true;
    }
    // other block types (server tools) are ignored
  }
  if (usage !== undefined) {
    const u = obj(usage);
    if (
      !u ||
      !isCount(u.input_tokens) ||
      !isCount(u.output_tokens) ||
      !optionalCount(u.cache_read_input_tokens) ||
      !optionalCount(u.cache_creation_input_tokens)
    ) {
      throw new LlmRequestError();
    }
    out.usage = usageFieldsOf(u);
  }
  return out;
}
