import type { Pool } from "pg";
import type { StartScheduler } from "./startScheduler";

export const STALE_UPLOAD_MS = 120_000;
export const SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const SWEEP_EVERY_MS = 60_000;
export const SWEEP_BATCH = 100;
/** The orphan status scan runs on every Nth sweep tick (about hourly), not every minute. */
export const SWEEP_ORPHAN_EVERY_TICKS = 60;

// The label a failed sweep-fired start is logged under (not an HTTP route).
const SWEEP_LABEL = "stale upload sweep";

// The SQL function never returns more than this, whatever limit is asked for.
const MAX_BATCH = 500;

const className = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

export interface SweepArgs {
  pool: Pool;
  starts: StartScheduler;
  olderThanMs: number;
  lookbackMs: number;
  limit: number;
  /** When aborted after the query, nothing is fired (shutdown: the starts are about to drain). */
  signal?: AbortSignal;
}

/**
 * Asks the start-once scheduler to start every document that has no current-generation status row.
 * The SQL function sees ids only (across tenants); each identity is built from the row's tenant and
 * owner, as an upload builds it. Never throws: a failure is logged by class only.
 */
export async function sweepStaleUploads(args: SweepArgs): Promise<number> {
  const { pool, starts, olderThanMs, lookbackMs, limit, signal } = args;
  try {
    const { rows } = await pool.query<{
      tenant_id: string;
      owner_id: string;
      id: string;
      generation: number;
    }>(
      `SELECT tenant_id, owner_id, id, generation
         FROM docmind_stale_uploads_v2(make_interval(secs => $1::float8), make_interval(secs => $2::float8), $3::integer)`,
      [olderThanMs / 1000, lookbackMs / 1000, limit],
    );
    if (signal?.aborted) return 0;
    // A full batch may hide older strays behind it (the scan has no cursor): say so, by count only.
    if (rows.length >= Math.min(limit, MAX_BATCH))
      console.warn("stale upload sweep batch was full", rows.length);
    for (const r of rows)
      starts.fire({ tenantId: r.tenant_id, userId: r.owner_id }, r.id, r.generation, SWEEP_LABEL);
    return rows.length;
  } catch (err) {
    console.error("stale upload sweep failed", className(err));
    return 0;
  }
}

/** What the orphan purge needs from the status model. */
export interface StatusForgetter {
  forgetExecution(executionId: string): Promise<void>;
}

/**
 * Tombstones the status rows whose document no longer exists (a delete that raced a first status
 * row). Goes through the status model, never a raw delete, so tombstones and versions stay right.
 * Never throws; a failure is logged by class only.
 */
export async function sweepOrphanStatuses(args: {
  pool: Pool;
  status: StatusForgetter;
  limit: number;
  signal?: AbortSignal;
}): Promise<number> {
  const { pool, status, limit, signal } = args;
  try {
    const { rows } = await pool.query<{ execution_id: string }>(
      "SELECT execution_id FROM docmind_orphan_statuses($1::integer)",
      [limit],
    );
    let purged = 0;
    for (const r of rows) {
      if (signal?.aborted) break;
      await status.forgetExecution(r.execution_id);
      purged++;
    }
    return purged;
  } catch (err) {
    console.error("orphan status sweep failed", className(err));
    return 0;
  }
}
