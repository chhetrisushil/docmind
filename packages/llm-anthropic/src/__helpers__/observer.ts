import type { CallObserver, LlmUsageDetail, ReasoningBlock, RefusalDetails } from "../observer";

/** A CallObserver that records every call (the response-side hooks; the request side has none). */
export function recordingObserver() {
  const log: string[] = [];
  const thinking: string[] = [];
  const blocks: { ids: readonly string[]; blocks: readonly ReasoningBlock[] }[] = [];
  const refusals: RefusalDetails[] = [];
  const usage: LlmUsageDetail[] = [];
  const observer: CallObserver = {
    onThinking(text) {
      thinking.push(text);
      log.push("thinking");
    },
    async onBlocks(ids, b) {
      blocks.push({ ids, blocks: b });
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
  return { observer, log, thinking, blocks, refusals, usage };
}
