import type { LlmContentPart, LlmReasoningPart } from "@loom/llm";

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
