import type { ChatEntry, ChatReasoning, ChatValue } from "@loom-ui/core/chat-ui";
import type { ChatFold } from "./feedAdapter";

const CURSOR = /^[0-9]{1,9}\.[0-9]{1,15}$/;
const MAX_TOOLS = 16;
const MAX_REFS = 64;

/** DocMind's extras laid onto the feed's value, in the shape loom-ui's `Chat` kind draws (tools, reasoning, reference ids). */
export function toTranscript(
  value: ChatValue,
  fold: Pick<ChatFold, "extrasOf" | "liveSteps" | "olderCursor">,
): ChatValue {
  const entries = value.entries.map((e): ChatEntry => {
    if (e.role !== "assistant" || e.status === "restricted") return e;
    const x = fold.extrasOf(e.id);
    const steps = e.status === "streaming" ? fold.liveSteps : (x?.steps ?? []);
    const tools = steps
      .slice(-MAX_TOOLS)
      .map((s) => ({ name: `${s.label} (${s.count})`.slice(0, 64), status: "done" as const }));
    const stored = x?.reasoning;
    const reasoning: ChatReasoning | undefined =
      e.reasoning ??
      (stored
        ? {
            text: stored.kind === "redacted" ? "" : stored.text,
            kind: stored.kind,
            streaming: false,
            ...(stored.status && { status: stored.status }),
            ...(stored.truncated && { truncated: true }),
          }
        : undefined);
    const ids =
      e.status === "streaming"
        ? []
        : [...new Set((x?.citations ?? []).map((c) => c.passageId))].slice(0, MAX_REFS);
    return {
      ...e,
      ...(tools.length > 0 && { tools }),
      ...(reasoning && { reasoning }),
      ...(ids.length > 0 && { refs: ids.map((id) => ({ id })) }),
    };
  });
  return {
    ...value,
    entries,
    refMarkers: true,
    ...(fold.olderCursor !== null && CURSOR.test(fold.olderCursor) && { older: fold.olderCursor }),
  };
}
