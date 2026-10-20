/**
 * An original response content block (thinking, redacted_thinking, text or tool_use), echoed verbatim.
 * The API checks a thinking block's signature, so a block is never edited or reordered.
 */
export interface ReasoningBlock {
  type: string;
  [k: string]: unknown;
}

export interface LlmUsageDetail {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** From the API's `stop_details`. The model's own words: the app seals them, nothing logs them. */
export interface RefusalDetails {
  category?: string;
  explanation?: string;
}

/**
 * Per-request hooks (D3). The app builds one per model call from its call scope; the provider never
 * stores one. Every method is called on every path described in the Phase A header, in that order.
 */
export interface CallObserver {
  onThinking?(text: string): void;
  onBlocks?(toolUseIds: readonly string[], blocks: readonly ReasoningBlock[]): Promise<void>;
  onRefusal(details: RefusalDetails): Promise<void>;
  onUsage(usage: LlmUsageDetail): void;
}

/** True for any content block: an object with a string `type`. */
export const isReasoningBlock = (b: unknown): b is ReasoningBlock =>
  typeof b === "object" && b !== null && typeof (b as { type?: unknown }).type === "string";

/** True for a thinking or redacted_thinking block: the blocks that take no `cache_control`. */
export const isThinkingBlock = (b: { type: string }): boolean =>
  b.type === "thinking" || b.type === "redacted_thinking";
