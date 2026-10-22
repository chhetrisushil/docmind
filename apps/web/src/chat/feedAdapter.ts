import type {
  ChatFailureReason,
  ChatMessageDto,
  ChatOutcome,
  ChatReasoningDto,
  ChatStreamEvent,
  ChatToolStep,
  Citation,
  ListMessagesResponse,
} from "@docmind/contracts";
import { ChatFeed } from "@loom-ui/core/chat";
import type { ChatValue } from "@loom-ui/core/chat-ui";

/** What the feed's contract has no room for, kept beside it and keyed by the entry id the feed assigns. */
export interface Extras {
  ord: number;
  citations: Citation[];
  steps: ChatToolStep[];
  reasoning: ChatReasoningDto | null;
  outcome: ChatOutcome | null;
}

type Keyed = Pick<ChatMessageDto, "role" | "turn" | "id">;

/** The id `ChatFeed` gives an entry: `t<turn>.assistant` for a reply, `m<ord>` for a user message (its record ordinal). */
export const entryIdOf = (m: Keyed): string =>
  m.role === "assistant" ? `t${m.turn}.assistant` : `m${Number(m.id)}`;

const REASON: Record<ChatOutcome, string> = {
  refusal: "refusal",
  max_tokens: "max-tokens",
  max_iterations: "max-iterations",
};

/** loom-ui has a sentence for each of Loom's failure reasons, so the token is the reason itself. */
const FAILURE_TOKEN: Record<ChatFailureReason, string> = {
  "model-error": "model-error",
  denied: "denied",
  "rate-limited": "rate-limited",
  quota: "quota",
  "tool-error": "tool-error",
  "turn-failed": "turn-failed",
  cancelled: "cancelled",
};

/** The shape `chatEntryFromWire` reads. The server's `createdAt` (ISO) becomes `at` (epoch ms); the ordinal `id` becomes `ord`. */
export function wireOfMessage(m: ChatMessageDto): Record<string, unknown> {
  const reason =
    m.status === "failed"
      ? // A newer server may send a reason this build does not know: the generic sentence.
        (FAILURE_TOKEN[m.failureReason ?? "model-error"] ?? "model-error")
      : m.status === "rejected"
        ? "rejected"
        : m.outcome
          ? REASON[m.outcome]
          : undefined;
  return {
    turn: m.turn,
    role: m.role,
    status: m.status,
    text: m.text,
    cursor: m.cursor,
    at: Date.parse(m.createdAt),
    ord: Number(m.id),
    ...(m.citations.length > 0 && { refs: [...new Set(m.citations.map((c) => c.passageId))] }),
    ...(reason !== undefined && { reason }),
  };
}

const extrasOf = (m: ChatMessageDto): Extras => ({
  ord: Number(m.id),
  citations: m.citations,
  steps: m.steps,
  reasoning: m.reasoning,
  outcome: m.outcome,
});

const MAX_LIVE_STEPS = 16;

/**
 * DocMind's messages and stream frames folded into loom-ui's `ChatFeed`. The feed owns ordering, de-duplication by
 * cursor, bounded live text, sanitising and live reasoning; this class translates the wire (spec §6.1) on the way in
 * and keeps the fields the feed's contract drops (citations, tool steps, history reasoning, outcome) in a side map.
 */
export class ChatFold {
  private readonly feed = new ChatFeed({
    mode: "owner",
    reasoning: true,
    refMarkers: true,
    markdown: true,
  });
  private readonly extras = new Map<string, Extras>();
  /** Tool steps of the reply in flight (the stream numbers them by turn key, which cannot be mapped to a turn). */
  liveSteps: ChatToolStep[] = [];
  error = false;
  /** The server's `nextCursor` of the oldest page loaded; `null` once the start of the chat is in the window. */
  olderCursor: string | null = null;
  historyLoaded = false;

  /** A page of `GET /api/chats/:id/messages` (oldest first within the page). The feed takes backward pages newest first. */
  applyHistory(page: ListMessagesResponse): void {
    for (const m of page.items) this.extras.set(entryIdOf(m), extrasOf(m));
    this.feed.applyHistory(
      { entries: [...page.items].reverse().map(wireOfMessage), done: page.nextCursor === null },
      "backward",
    );
    this.olderCursor = page.nextCursor;
    this.historyLoaded = true;
  }

  applyStream(ev: ChatStreamEvent): void {
    switch (ev.kind) {
      case "message":
        this.extras.set(entryIdOf(ev), extrasOf(ev));
        this.feed.applyEvent("message", wireOfMessage(ev));
        if (ev.role === "assistant") this.liveSteps = [];
        break;
      case "status":
        this.feed.applyEvent("status", { state: ev.state, running: ev.running });
        break;
      case "reasoning":
      case "reasoning-partial":
        this.feed.applyEvent(ev.kind, { turn: ev.turn, text: ev.text });
        break;
      case "answer": // the feed's `delta`
        this.feed.applyEvent("delta", { turn: ev.turn, text: ev.text });
        break;
      case "reset":
        this.feed.applyEvent("reset", { turn: ev.turn });
        this.liveSteps = [];
        break;
      case "tool":
        this.liveSteps = [...this.liveSteps, ev.step].slice(-MAX_LIVE_STEPS);
        break;
      case "tool-reset":
        this.liveSteps = [];
        break;
      case "closed":
        this.feed.applyEvent("closed", {});
        break;
      case "error":
        this.error = true;
        break;
    }
  }

  /** Called when the stream (re)opens: it starts with a snapshot of the reply so far, which must land on an empty live reply. */
  resetLive(): void {
    this.error = false;
    const live = this.feed.value().entries.find((e) => e.status === "streaming");
    if (live) this.feed.applyEvent("reset", { turn: live.turn });
    this.liveSteps = [];
  }

  /**
   * A reply is pending when one is streaming, or the newest turn is a user question nobody has answered or refused yet;
   * never once the chat is closed. It does not clear on a stop or a transport problem: the controller must not rely on
   * it for those paths and settles its own busy state.
   */
  replyPending(): boolean {
    if (this.feed.value().state === "closed") return false;
    const entries = this.feed.value().entries;
    if (entries.some((e) => e.status === "streaming")) return true;
    const last = entries.at(-1);
    return last?.role === "user" && last.status !== "rejected";
  }

  value(): ChatValue {
    return this.feed.value();
  }
  extrasOf(entryId: string): Extras | undefined {
    return this.extras.get(entryId);
  }
  resumeCursor(): string | undefined {
    return this.feed.resumeCursor();
  }
}
