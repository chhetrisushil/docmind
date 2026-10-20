import type { ChatToolStep } from "@docmind/contracts";

export type LiveChatEvent =
  | { kind: "thinking"; turnKey: number; text: string }
  | { kind: "tool"; turnKey: number; step: ChatToolStep }
  | { kind: "reset"; turnKey: number };

export class ChatBusLimitError extends Error {
  constructor() {
    super("too many listeners for this chat");
    this.name = "ChatBusLimitError";
  }
}

export interface ChatBusOptions {
  /** Characters of one turn's thinking kept for a late joiner (the tail). Default 16 384. */
  maxThinkingChars?: number;
  /** Chats whose partial is remembered at once. Default 1 024. */
  maxChats?: number;
  /** Listeners per chat. Default 16. */
  maxSubscribersPerChat?: number;
}

interface Partial {
  turnKey: number;
  thinking: string;
}

/**
 * The in-process side channel for what Loom's hub does not carry: summarized thinking and tool steps
 * (D7). Live only and lossy by design: anything a late or slow listener misses is in the durable turn
 * items. Holds the running turn's thinking so a stream that connects mid-turn can catch up once.
 * Memory only: a crash loses it, and the recovered turn sends `reset` (D16).
 */
export class ChatBus {
  private readonly subs = new Map<string, Set<(e: LiveChatEvent) => void>>();
  private readonly partials = new Map<string, Partial>();
  private readonly maxChars: number;
  private readonly maxChats: number;
  private readonly maxSubs: number;

  constructor(options: ChatBusOptions = {}) {
    this.maxChars = options.maxThinkingChars ?? 16_384;
    this.maxChats = options.maxChats ?? 1_024;
    this.maxSubs = options.maxSubscribersPerChat ?? 16;
  }

  publish(chatId: string, e: LiveChatEvent): void {
    if (e.kind === "thinking") this.append(chatId, e.turnKey, e.text);
    else if (e.kind === "reset") this.partials.delete(chatId);
    for (const fn of [...(this.subs.get(chatId) ?? [])]) {
      try {
        fn(e);
      } catch {
        // a listener cannot hurt the turn
      }
    }
  }

  subscribe(chatId: string, fn: (e: LiveChatEvent) => void): () => void {
    let set = this.subs.get(chatId);
    if (!set) {
      set = new Set();
      this.subs.set(chatId, set);
    }
    if (set.size >= this.maxSubs) throw new ChatBusLimitError();
    set.add(fn);
    return () => {
      const cur = this.subs.get(chatId);
      cur?.delete(fn);
      if (cur?.size === 0) this.subs.delete(chatId);
    };
  }

  /** The running turn's thinking so far, or null. */
  partial(chatId: string): Partial | null {
    const p = this.partials.get(chatId);
    return p ? { ...p } : null;
  }

  /** The turn's reply is durable: forget its partial (an earlier turn's end changes nothing). */
  end(chatId: string, turnKey: number): void {
    if (this.partials.get(chatId)?.turnKey === turnKey) this.partials.delete(chatId);
  }

  private append(chatId: string, turnKey: number, text: string): void {
    const cur = this.partials.get(chatId);
    const joined = (cur?.turnKey === turnKey ? cur.thinking : "") + text;
    const thinking =
      joined.length > this.maxChars ? joined.slice(joined.length - this.maxChars) : joined;
    this.partials.delete(chatId); // re-insert: Map order is write recency
    this.partials.set(chatId, { turnKey, thinking });
    if (this.partials.size > this.maxChats) {
      const oldest = this.partials.keys().next().value;
      if (oldest !== undefined) this.partials.delete(oldest);
    }
  }
}
