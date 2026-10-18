/** Counts operations in progress per key (a user id), within this process. */
export class InFlight {
  private readonly counts = new Map<string, number>();

  /** A release function, or null when `key` already has `max` in flight. */
  tryAcquire(key: string, max: number): (() => void) | null {
    const current = this.counts.get(key) ?? 0;
    if (current >= max) return null;
    this.counts.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.counts.get(key) ?? 1) - 1;
      if (left <= 0) this.counts.delete(key);
      else this.counts.set(key, left);
    };
  }
}
