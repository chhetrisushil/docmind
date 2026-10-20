import type { BargeInSource } from "@loom/conversation";

/**
 * The in-process stop signal (D8, H6). Loom fires a turn's abort only when a NEW message lands, so a stop
 * is a second source for the same abort: `stoppableBargeIn` subscribes each running turn here, and
 * `POST /api/chats/:id/stop` calls `stop`. In memory and per process, which v1's single-process rule
 * (spec 5.2) allows.
 */
export class StopRegistry {
  private readonly listeners = new Map<string, Set<() => void>>();

  /** Register a listener for the conversation; the returned function removes it (idempotent). */
  on(conversationId: string, fn: () => void): () => void {
    let set = this.listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.listeners.set(conversationId, set);
    }
    set.add(fn);
    return () => {
      const cur = this.listeners.get(conversationId);
      cur?.delete(fn);
      if (cur?.size === 0) this.listeners.delete(conversationId);
    };
  }

  /** Fire the conversation's listeners. True when a turn was listening (so there was something to stop). */
  stop(conversationId: string): boolean {
    const set = this.listeners.get(conversationId);
    if (!set || set.size === 0) return false;
    for (const fn of [...set]) {
      try {
        fn();
      } catch {
        // one listener cannot keep another from stopping
      }
    }
    return true;
  }

  running(conversationId: string): boolean {
    return (this.listeners.get(conversationId)?.size ?? 0) > 0;
  }
}

/**
 * `inner` (Loom's `inboxBargeIn`) plus the stop signal: both fire the turn's own `handlers.onMessage`,
 * which aborts the turn at its next recorded checkpoint and, through `hub.wrapProvider`, cuts the model
 * stream. The turn is then recorded `interrupted` with the text so far, and the conversation parks for
 * the next message (nothing was sent, so there is no next turn).
 */
export function stoppableBargeIn(inner: BargeInSource, stops: StopRegistry): BargeInSource {
  return async (conversationId, ownerId, handlers) => {
    const offStop = stops.on(conversationId, handlers.onMessage);
    try {
      const offInner = await inner(conversationId, ownerId, handlers);
      return () => {
        offStop();
        offInner();
      };
    } catch (err) {
      offStop();
      throw err;
    }
  };
}
