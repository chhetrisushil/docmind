import type { ReactiveController, ReactiveControllerHost } from "lit";
import { report } from "../report";

/** A value that tells its subscribers when it changes. Stores never touch the DOM. */
export class Store<T> {
  private value: T;
  private readonly listeners = new Set<(v: T) => void>();
  constructor(initial: T) {
    this.value = initial;
  }
  get(): T {
    return this.value;
  }
  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const fn of [...this.listeners]) {
      try {
        fn(next);
      } catch (err) {
        report("store", err);
      }
    }
  }
  update(fn: (cur: T) => T): void {
    this.set(fn(this.value));
  }
  subscribe(fn: (v: T) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

/** Re-renders a Lit host whenever the store changes, for as long as the host is connected. */
export class StoreController<T> implements ReactiveController {
  private off: (() => void) | undefined;
  constructor(
    private readonly host: ReactiveControllerHost,
    readonly store: Store<T>,
  ) {
    host.addController(this);
  }
  get value(): T {
    return this.store.get();
  }
  hostConnected(): void {
    this.off = this.store.subscribe(() => this.host.requestUpdate());
  }
  hostDisconnected(): void {
    this.off?.();
    this.off = undefined;
  }
}
