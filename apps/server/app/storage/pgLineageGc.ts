import type { Lineage } from "@loom-ui/lineage";
import type { Pool } from "pg";
import { pgSessionLock } from "../db/sessionLock";
import type { LineageGcDeps, MaintenanceRuns } from "./lineageGc";
import type { PgContentStore } from "./pgContentStore";

/** The session advisory lock one collection holds, on the Loom database (every replica shares it). */
export const LINEAGE_GC_LOCK_KEY = "docmind:lineage-gc";
/** The collector's row in `maintenance_runs`. */
export const LINEAGE_GC_JOB = "lineage-gc";

/** `maintenance_runs` (migration 0031) on the app pool: every comparison uses the database's `now()`, never a replica's clock. */
export class PgMaintenanceRuns implements MaintenanceRuns {
  constructor(private readonly pool: Pool) {}

  async due(name: string, everyMs: number): Promise<boolean> {
    const { rows } = await this.pool.query<{ due: boolean }>(
      `SELECT coalesce(
         (SELECT now() - last_run_at >= $2::double precision * interval '1 millisecond'
            FROM maintenance_runs WHERE name = $1), true) AS due`,
      [name, everyMs],
    );
    return rows[0]?.due === true;
  }

  async markRun(name: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO maintenance_runs (name, last_run_at) VALUES ($1, now())
       ON CONFLICT (name) DO UPDATE SET last_run_at = EXCLUDED.last_run_at`,
      [name],
    );
  }
}

/**
 * The production collector deps. `lineage` is THE visuals `Lineage` (one instance holds every line: document
 * `visuals-*` and chat-turn `turnvisuals-*`, all users) over the SEALED store, so `pins()` can open the retained
 * artifacts to find the refs inside them; `store` is the raw `PgContentStore` underneath it (the only one with the
 * sweep set). Every version of every line is kept (`keepLast: Infinity`): this collector reclaims blobs nothing
 * names, never history. The lock is on the Loom pool, the schedule record and the blobs on the app pool.
 */
export function lineageGcDeps(
  parts: { lineage: Pick<Lineage, "pins">; store: PgContentStore },
  loomPool: Pool,
  appPool: Pool,
  everyMs: number,
): LineageGcDeps {
  return {
    // concurrency 2 (default 8): artifacts are read through the app pool, which has 10 connections by default, and a
    // daily background run must not take most of them from requests.
    pins: () => parts.lineage.pins({ keepLast: Number.POSITIVE_INFINITY }, { concurrency: 2 }),
    store: parts.store,
    lock: () => pgSessionLock(loomPool, LINEAGE_GC_LOCK_KEY, "lineage gc lock"),
    schedule: { name: LINEAGE_GC_JOB, everyMs, runs: new PgMaintenanceRuns(appPool) },
  };
}
