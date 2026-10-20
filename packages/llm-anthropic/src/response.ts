import { LlmRequestError } from "./errors";
import { isCount } from "./mapping";

export interface Parsed {
  content: { type: string; text?: string }[];
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/** Validates the response by hand. Never puts the text in an error. */
export function parseResponse(text: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LlmRequestError();
  }
  const o = raw as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null) throw new LlmRequestError();
  const { content, stop_reason: stop, usage } = o;
  if (
    !Array.isArray(content) ||
    typeof stop !== "string" ||
    !content.every(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        typeof b.type === "string" &&
        (b.text === undefined || typeof b.text === "string"),
    )
  ) {
    throw new LlmRequestError();
  }
  if (usage !== undefined) {
    const u = usage as Record<string, unknown> | null;
    if (
      typeof u !== "object" ||
      u === null ||
      !isCount(u.input_tokens) ||
      !isCount(u.output_tokens)
    ) {
      throw new LlmRequestError();
    }
  }
  return o as unknown as Parsed;
}
