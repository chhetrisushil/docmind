import type { Pool } from "pg";
import type { StartScheduler } from "./startScheduler";
import { STALE_UPLOAD_MS, SWEEP_BATCH, sweepStaleUploads } from "./sweep";

const DAY_MS = 86_400_000;
/** The SQL function's own clamp on the lookback. */
export const MAX_BACKFILL_DAYS = 400;
// The SQL function never returns more than this, whatever limit is asked for.
const MAX_BATCH = 500;

export interface BackfillOptions {
  lookbackDays: number;
  batch?: number;
  signal?: AbortSignal;
}

/**
 * Starts ingestion for documents with no current-generation status row that are older than the stale
 * grace and younger than `lookbackDays` (the periodic sweep only looks back seven days). Sweeps in
 * batches, waiting for the starts to land between them, until a batch comes back short. The SQL scan
 * has no cursor, so a document whose status row has not appeared yet can come back in the next batch:
 * each document is fired once per run, and a batch with nothing new ends the run. Returns the number
 * of documents started.
 */
export async function runBackfill(
  pool: Pool,
  starts: Pick<StartScheduler, "fire" | "idle">,
  { lookbackDays, batch = SWEEP_BATCH, signal }: BackfillOptions,
): Promise<number> {
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > MAX_BACKFILL_DAYS)
    throw new RangeError("lookbackDays must be an integer from 1 to 400");
  const limit = Math.min(Math.max(1, Math.floor(batch)), MAX_BATCH);
  const seen = new Set<string>();
  const once: Pick<StartScheduler, "fire"> = {
    fire(identity, id, generation, label) {
      if (seen.has(id)) return;
      seen.add(id);
      starts.fire(identity, id, generation, label);
    },
  };
  for (;;) {
    const before = seen.size;
    const asked = await sweepStaleUploads({
      pool,
      starts: once,
      olderThanMs: STALE_UPLOAD_MS,
      lookbackMs: lookbackDays * DAY_MS,
      limit,
      ...(signal && { signal }),
    });
    await starts.idle();
    if (asked < limit || seen.size === before || signal?.aborted) return seen.size;
  }
}
