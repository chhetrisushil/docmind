import type {
  LlmContentPart,
  LlmLayoutEntry,
  LlmReasoning,
  LlmReasoningPart,
  LlmToolCall,
} from "@loom/llm";
import { layoutOf } from "@loom/llm";
import type { ContentBlock } from "./mapping";

/** The provider id on every reasoning part: a part is only sent back to the provider that produced it (ADR 0133 D2). */
export const PROVIDER_ID = "anthropic";

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}
export interface RedactedBlock {
  type: "redacted_thinking";
  data: string;
}

/**
 * An assistant `reasoning` part back to the vendor block, UNCHANGED (ADR 0133 D5): a `thinking` block with its
 * text (resolved by Loom from the sidecar; "" for an omitted-display block) and signature, or a
 * `redacted_thinking` block whose `data` is the recorded signature.
 */
export function wireBlockOf(p: LlmReasoningPart): ThinkingBlock | RedactedBlock {
  if (p.kind === "redacted") return { type: "redacted_thinking", data: p.signature ?? "" };
  return {
    type: "thinking",
    thinking: p.text ?? "",
    ...(p.signature !== undefined && { signature: p.signature }),
  };
}

/**
 * The parts of one assistant message that may be sent. Stripping reasoning is always valid, so anything
 * doubtful is stripped, never repaired: another provider's parts (their signatures mean nothing here); every
 * reasoning part when thinking is off; and, because a signature binds the blocks before it, a part with no
 * signature together with every LATER reasoning part of the message.
 */
export function usableReasoning(
  parts: readonly LlmContentPart[],
  thinking: boolean,
): LlmContentPart[] {
  let cut = false;
  return parts.filter((p) => {
    if (p.type !== "reasoning") return true;
    if (!thinking || p.provider !== PROVIDER_ID || cut) return false;
    if (p.signature === undefined || p.signature === "") {
      cut = true;
      return false;
    }
    return true;
  });
}

/**
 * ADR 0133 D2, ONE rule shared by complete() and stream(): a non-empty `thinking` text is a `summary` (current
 * models return only summaries), an empty one is `text` with `text: ""` (an omitted-display block: the signature
 * carries it), and `redacted_thinking` is `redacted` with its `data` as the signature.
 */
export function reasoningOf(block: ContentBlock): LlmReasoning | undefined {
  if (block.type === "redacted_thinking") {
    return {
      kind: "redacted",
      ...(typeof block.data === "string" && { signature: block.data }),
      provider: PROVIDER_ID,
    };
  }
  if (block.type !== "thinking") return undefined;
  const text = typeof block.thinking === "string" ? block.thinking : "";
  return {
    kind: text === "" ? "text" : "summary",
    text,
    ...(typeof block.signature === "string" && { signature: block.signature }),
    provider: PROVIDER_ID,
  };
}

export interface Outcome {
  content: string;
  toolCalls: LlmToolCall[];
  reasoning?: LlmReasoning[];
  layout?: LlmLayoutEntry[];
}

/**
 * The text, tool calls, reasoning and block order of a response's validated blocks, in the order the API sent
 * them. `layout` is present only when there is reasoning and the order is not canonical (`layoutOf`), so a
 * response without thinking has exactly today's shape (Loom G2).
 */
export function outcomeOf(blocks: readonly ContentBlock[]): Outcome {
  let content = "";
  const toolCalls: LlmToolCall[] = [];
  const reasoning: LlmReasoning[] = [];
  const entries: LlmLayoutEntry[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      const text = b.text as string;
      content += text;
      entries.push({ text: text.length });
    } else if (b.type === "tool_use") {
      const id = b.id as string;
      toolCalls.push({ id, name: b.name as string, input: b.input });
      entries.push({ call: id });
    } else {
      const r = reasoningOf(b);
      if (r !== undefined) {
        reasoning.push(r);
        entries.push("reasoning");
      }
    }
  }
  const layout = layoutOf(entries);
  return {
    content,
    toolCalls,
    ...(reasoning.length > 0 && { reasoning }),
    ...(layout !== undefined && { layout }),
  };
}

/** A refused response ends the turn with its text only: no tool calls, no reasoning, no layout. */
export function refusedOutcomeOf(blocks: readonly ContentBlock[]): Outcome {
  return {
    content: blocks.map((b) => (b.type === "text" ? (b.text as string) : "")).join(""),
    toolCalls: [],
  };
}
