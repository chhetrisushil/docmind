import type { CallObserver, LlmUsageDetail, ReasoningBlock, RefusalDetails } from "../observer";

/** A CallObserver that records every call. `stored` is the block store: onBlocks writes it, blocksFor reads it. */
export function recordingObserver(stored: Map<string, readonly ReasoningBlock[]> = new Map()) {
  const log: string[] = [];
  const asked: (readonly string[])[] = [];
  const thinking: string[] = [];
  const blocks: { ids: readonly string[]; blocks: readonly ReasoningBlock[] }[] = [];
  const refusals: RefusalDetails[] = [];
  const usage: LlmUsageDetail[] = [];
  const observer: CallObserver = {
    async blocksFor(ids) {
      asked.push(ids);
      log.push("blocksFor");
      return stored.get(ids.join(",")) ?? [];
    },
    onThinking(text) {
      thinking.push(text);
      log.push("thinking");
    },
    async onBlocks(ids, b) {
      blocks.push({ ids, blocks: b });
      stored.set(ids.join(","), b);
      log.push("blocks");
    },
    async onRefusal(details) {
      refusals.push(details);
      log.push("refusal");
    },
    onUsage(u) {
      usage.push(u);
      log.push("usage");
    },
  };
  return { observer, log, asked, thinking, blocks, refusals, usage, stored };
}
