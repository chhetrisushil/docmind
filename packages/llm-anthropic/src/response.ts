import type { LlmToolCall } from "@loom/llm";
import { LlmRequestError } from "./errors";
import { type UsageFields, isCount, obj, toContentBlock, usageFieldsOf } from "./mapping";
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
    const block = toContentBlock(b);
    if (!block) continue; // an empty text block or an unknown type (server tools): ignored
    out.blocks.push(block);
    if (block.type === "text") out.text += block.text as string;
    else if (block.type === "tool_use") {
      out.toolCalls.push({
        id: block.id as string,
        name: block.name as string,
        input: block.input,
      });
    } else {
      out.sawThinking = true;
      if (block.type === "thinking") out.thinking.push(block.thinking as string);
    }
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
