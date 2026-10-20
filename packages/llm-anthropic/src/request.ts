import {
  type LlmContentPart,
  type LlmRequest,
  type LlmResultPart,
  fenceUntrustedMedia,
} from "@loom/llm";
import { LlmRequestError } from "./errors";
import { type ReasoningBlock, isReasoningBlock, isThinkingBlock } from "./observer";

export const EFFORTS = ["low", "medium", "high", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface CacheControl {
  type: "ephemeral";
}
const EPHEMERAL: CacheControl = { type: "ephemeral" };
type Cacheable = { cache_control?: CacheControl };

type TextBlock = { type: "text"; text: string } & Cacheable;
type MediaBlock = {
  type: "image" | "document";
  source: { type: "base64"; media_type: string; data: string };
} & Cacheable;
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown } & Cacheable;
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | (TextBlock | MediaBlock)[];
  is_error?: true;
} & Cacheable;
export type Block = TextBlock | MediaBlock | ToolUseBlock | ToolResultBlock | ReasoningBlock;

export interface AnthropicBody {
  model: string;
  max_tokens: number;
  stream?: true;
  system?: string | TextBlock[];
  temperature?: number;
  thinking?: { type: "adaptive"; display: "summarized" };
  output_config?: { effort: Effort };
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
  messages: { role: "user" | "assistant"; content: Block[] }[];
}

export interface BodyOptions {
  thinking?: boolean;
  effort?: Effort;
  cache?: boolean;
  stream?: boolean;
  /** Stored response content that replaces the assistant message at this index of `request.messages` (system messages count). */
  reasoning?: ReadonlyMap<number, readonly ReasoningBlock[]>;
}

const leaf = (part: LlmContentPart | LlmResultPart): TextBlock | MediaBlock => {
  if (part.type === "text") return { type: "text", text: part.text };
  if ((part.type === "image" || part.type === "file") && part.source.kind === "data") {
    if (part.type === "file" && part.mediaType.toLowerCase() !== "application/pdf") {
      throw new LlmRequestError();
    }
    return {
      type: part.type === "image" ? "image" : "document",
      source: { type: "base64", media_type: part.mediaType, data: part.source.data },
    };
  }
  throw new LlmRequestError(); // refs and audio: not supported by this provider
};

const block = (part: LlmContentPart): Block => {
  if (part.type === "tool_use") {
    return { type: "tool_use", id: part.id, name: part.name, input: part.input };
  }
  if (part.type === "tool_result") {
    const content =
      typeof part.content === "string" ? part.content : fenceUntrustedMedia(part.content).map(leaf);
    return {
      type: "tool_result",
      tool_use_id: part.toolUseId,
      content,
      ...(part.isError === true && { is_error: true as const }),
    };
  }
  return leaf(part);
};

/** The `tool_use` ids of each assistant message, with the message's index in `request.messages`. */
export function toolUseGroups(request: LlmRequest): { index: number; ids: string[] }[] {
  const out: { index: number; ids: string[] }[] = [];
  request.messages.forEach((m, index) => {
    if (m.role !== "assistant" || typeof m.content === "string") return;
    const ids = m.content.flatMap((p) => (p.type === "tool_use" ? [p.id] : []));
    if (ids.length > 0) out.push({ index, ids });
  });
  return out;
}

/** Loom's request to the Messages API body. System messages join the top-level system text. */
export function toMessagesBody(
  request: LlmRequest,
  model: string,
  maxTokens: number,
  options: BodyOptions = {},
): AnthropicBody {
  const system: string[] = request.system ? [request.system] : [];
  const messages: AnthropicBody["messages"] = [];
  for (const [i, m] of request.messages.entries()) {
    const parts =
      typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    if (m.role === "system") {
      for (const p of parts) {
        if (p.type !== "text") throw new LlmRequestError();
        system.push(p.text);
      }
      continue;
    }
    for (const p of parts) {
      if (p.type === "tool_use" && m.role !== "assistant") throw new LlmRequestError();
      if (p.type === "tool_result" && m.role !== "user") throw new LlmRequestError();
    }
    const stored = m.role === "assistant" ? options.reasoning?.get(i) : undefined;
    if (stored !== undefined && !stored.every(isReasoningBlock)) throw new LlmRequestError();
    const content: Block[] = stored
      ? [...stored]
      : fenceUntrustedMedia(parts)
          .map(block)
          .filter((b) => !(m.role === "assistant" && b.type === "text" && b.text === ""));
    messages.push({ role: m.role, content });
  }
  if (options.cache === true) {
    const last = messages.at(-1)?.content.at(-1);
    if (last !== undefined && !isThinkingBlock(last)) (last as Cacheable).cache_control = EPHEMERAL;
  }
  const tools = request.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { type: "object", ...t.inputSchema },
  }));
  const text = system.join("\n\n");
  return {
    model,
    max_tokens: maxTokens,
    ...(options.stream === true && { stream: true as const }),
    ...(system.length > 0 && {
      system:
        options.cache === true ? [{ type: "text" as const, text, cache_control: EPHEMERAL }] : text,
    }),
    // Thinking and a custom temperature do not go together; thinking wins.
    ...(request.temperature !== undefined &&
      options.thinking !== true && { temperature: request.temperature }),
    ...(options.thinking === true && {
      thinking: { type: "adaptive" as const, display: "summarized" as const },
    }),
    ...(options.effort !== undefined && { output_config: { effort: options.effort } }),
    ...(tools && tools.length > 0 && { tools }),
    messages,
  };
}
