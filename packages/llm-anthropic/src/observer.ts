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
 * Per-request hooks (M4 D3, after the ADR 0133 amendment). The app builds one per model call from its call
 * scope; the provider never stores one. Reasoning is NOT here any more: it travels in `LlmResponse.reasoning`,
 * `layout` and `reasoningDelta`, and Loom captures it. What remains is what Loom's response type cannot carry:
 * a refusal (`stopReason` has no `refusal`) and token usage with cache detail.
 */
export interface CallObserver {
  onRefusal(details: RefusalDetails): Promise<void>;
  onUsage(usage: LlmUsageDetail): void;
}
