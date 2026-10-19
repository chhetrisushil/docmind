import type { LlmContentPart, LlmRequest } from "@loom/llm";
import { LlmRequestError } from "./errors";

type Block =
  | { type: "text"; text: string }
  | { type: "image" | "document"; source: { type: "base64"; media_type: string; data: string } };

export interface AnthropicBody {
  model: string;
  max_tokens: number;
  system?: string;
  temperature?: number;
  messages: { role: "user" | "assistant"; content: Block[] }[];
}

const block = (part: LlmContentPart): Block => {
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
  throw new LlmRequestError(); // refs, audio, tool parts: not supported by this provider (M3b)
};

/** Loom's request to the Messages API body. System messages join the top-level system text. */
export function toMessagesBody(
  request: LlmRequest,
  model: string,
  maxTokens: number,
): AnthropicBody {
  if (request.tools && request.tools.length > 0) throw new LlmRequestError();
  const system: string[] = request.system ? [request.system] : [];
  const messages: AnthropicBody["messages"] = [];
  for (const m of request.messages) {
    const parts =
      typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    if (m.role === "system") {
      for (const p of parts) {
        if (p.type !== "text") throw new LlmRequestError();
        system.push(p.text);
      }
      continue;
    }
    messages.push({ role: m.role, content: parts.map(block) });
  }
  return {
    model,
    max_tokens: maxTokens,
    ...(system.length > 0 && { system: system.join("\n\n") }),
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    messages,
  };
}
