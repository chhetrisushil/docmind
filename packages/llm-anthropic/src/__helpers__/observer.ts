import type { CallObserver, LlmUsageDetail, RefusalDetails } from "../observer";

/** A CallObserver that records every call, in order. */
export function recordingObserver() {
  const log: string[] = [];
  const refusals: RefusalDetails[] = [];
  const usage: LlmUsageDetail[] = [];
  const observer: CallObserver = {
    async onRefusal(details) {
      refusals.push(details);
      log.push("refusal");
    },
    onUsage(u) {
      usage.push(u);
      log.push("usage");
    },
  };
  return { observer, log, refusals, usage };
}
