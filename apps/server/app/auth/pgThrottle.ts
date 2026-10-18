import type { Throttle, ThrottlePolicy } from "@docmind/auth";
import type { Pool } from "pg";

/** Throttle on Postgres (migration 0006), connected as docmind_app. */
export class PgThrottle implements Throttle {
  constructor(private readonly pool: Pool) {}

  async retryAfter(keys: readonly string[]): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT public.throttle_retry_after($1::text[]) AS wait",
      [keys],
    );
    return rows[0].wait;
  }

  async fail(key: string, p: ThrottlePolicy): Promise<void> {
    await this.pool.query("SELECT public.throttle_fail($1, $2, $3, $4, $5)", [
      key,
      p.free,
      p.baseSeconds,
      p.capSeconds,
      p.decaySeconds,
    ]);
  }

  async clear(key: string): Promise<void> {
    await this.pool.query("SELECT public.throttle_clear($1)", [key]);
  }

  /** Deletes counters that are unlocked and idle for a day; returns how many. */
  async purge(): Promise<number> {
    const { rows } = await this.pool.query("SELECT public.throttle_purge() AS n");
    return Number(rows[0].n);
  }
}
