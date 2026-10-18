import { type Throttle, type ThrottlePolicy, lockSeconds } from "./throttle";

interface Row {
  failures: number;
  lockedUntil: number;
  updatedAt: number;
}

/** A Throttle in memory, for tests of everything built on the interface. `now` is settable. */
export class MemoryThrottle implements Throttle {
  now: () => number = () => Date.now();
  private readonly rows = new Map<string, Row>();

  async retryAfter(keys: readonly string[]): Promise<number> {
    const now = this.now();
    let wait = 0;
    for (const key of keys) {
      const row = this.rows.get(key);
      if (row && row.lockedUntil > now)
        wait = Math.max(wait, Math.ceil((row.lockedUntil - now) / 1000));
    }
    return wait;
  }

  async fail(key: string, policy: ThrottlePolicy): Promise<void> {
    const now = this.now();
    const old = this.rows.get(key);
    const stale = !old || now - old.updatedAt >= policy.decaySeconds * 1000;
    const failures = stale ? 1 : old.failures + 1;
    const lock = lockSeconds(policy, failures);
    const lockedUntil = lock > 0 ? now + lock * 1000 : stale ? now : (old?.lockedUntil ?? now);
    this.rows.set(key, { failures, lockedUntil, updatedAt: now });
  }

  async clear(key: string): Promise<void> {
    this.rows.delete(key);
  }
}
