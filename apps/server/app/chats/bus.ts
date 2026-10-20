import type { ChatToolStep } from "@docmind/contracts";

export type LiveChatEvent =
  | { kind: "tool"; turnKey: number; step: ChatToolStep }
  | { kind: "reset"; turnKey: number };

export class ChatBusLimitError extends Error {
  constructor() {
    super("too many listeners for this chat");
    this.name = "ChatBusLimitError";
  }
}

export interface ChatBusOptions {
  /** Listeners per chat. Default 16. */
  maxSubscribersPerChat?: number;
}

/**
 * The in-process side channel for what Loom's hub does not carry: tool steps (D7). Reasoning is not here any
 * more: it travels on the hub's `reasoning` events (ADR 0133 D6). Live only and lossy by design: anything a late
 * or slow listener misses is in the durable turn items. Memory only: a crash loses it, and the recovered turn
 * sends `reset` (D16).
 */
export class ChatBus {
  private readonly subs = new Map<string, Set<(e: LiveChatEvent) => void>>();
  private readonly maxSubs: number;

  constructor(options: ChatBusOptions = {}) {
    this.maxSubs = options.maxSubscribersPerChat ?? 16;
  }

  publish(chatId: string, e: LiveChatEvent): void {
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
}
