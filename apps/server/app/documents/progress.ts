import { DocumentProgressEvent } from "@docmind/contracts";

export interface ProgressScope {
  userId: string;
}
export interface ProgressBus {
  publish(scope: ProgressScope, event: DocumentProgressEvent): void;
  subscribe(scope: ProgressScope, listener: (event: DocumentProgressEvent) => void): () => void;
}

type Listener = (event: DocumentProgressEvent) => void;

/** In-process (Decision D8). A Postgres LISTEN/NOTIFY bus can replace it behind the same interface. */
export class InMemoryProgressBus implements ProgressBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(scope: ProgressScope, event: DocumentProgressEvent): void {
    const parsed = DocumentProgressEvent.safeParse(event);
    if (!parsed.success) throw new Error("invalid progress event");
    for (const listener of [...(this.listeners.get(scope.userId) ?? [])]) {
      try {
        listener(parsed.data);
      } catch {
        // one subscriber's failure must not stop the publisher or the other subscribers
      }
    }
  }

  subscribe(scope: ProgressScope, listener: Listener): () => void {
    let set = this.listeners.get(scope.userId);
    if (!set) {
      set = new Set();
      this.listeners.set(scope.userId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(scope.userId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(scope.userId);
    };
  }
}
