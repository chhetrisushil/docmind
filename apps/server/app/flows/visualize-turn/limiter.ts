/**
 * A sliding window per user (default 10 per minute), in memory: DocMind runs one server per database. A request that is
 * refused is not recorded, so a client that keeps trying is let in as soon as its oldest request leaves the window.
 */
export class UserRateLimit {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;
  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(userId: string): boolean {
    const t = this.now();
    this.sweep(t);
    const recent = (this.hits.get(userId) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(userId, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(userId, recent);
    return true;
  }

  size(): number {
    return this.hits.size;
  }

  /** Drops users whose newest request is out of the window (at most once per window, so a request stays cheap). */
  private sweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return;
    this.lastSweep = t;
    for (const [user, list] of this.hits)
      if (list.every((at) => t - at >= this.windowMs)) this.hits.delete(user);
  }
}
