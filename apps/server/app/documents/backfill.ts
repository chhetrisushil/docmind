import type { Pool } from "pg";
import type { StartScheduler } from "./startScheduler";
import { MAX_BATCH, STALE_UPLOAD_MS, SWEEP_BATCH, sweepStaleUploads } from "./sweep";

const DAY_MS = 86_400_000;
/** The SQL function's own clamp on the lookback. */
export const MAX_BACKFILL_DAYS = 400;
/** Re-queries (after draining the status feed) a full batch that brought nothing new before giving up. */
const MAX_STUCK_RETRIES = 3;

export interface BackfillOptions {
  lookbackDays: number;
  batch?: number;
  signal?: AbortSignal;
  /** Waits for the status model to fold what was started (its rows are what the scan checks). */
  drain?: () => Promise<void>;
}

export interface BackfillResult {
  /** Distinct documents handed to the start scheduler (the scheduler's counts say how many really started). */
  fired: number;
  /** A full batch kept coming back with nothing new: more strays may lie behind it. Run again. */
  incomplete: boolean;
}

/**
 * Starts ingestion for documents with no current-generation status row that are older than the stale
 * grace and younger than `lookbackDays` (the periodic sweep only looks back seven days). Sweeps in
 * batches, waiting for the starts to land between them, until a batch comes back short. The SQL scan
 * has no cursor, so a document whose status row has not appeared yet can come back in the next batch:
 * each document is fired once per run, and a full batch with nothing new is retried after `drain()`, a bounded number of
 * times, then reported as `incomplete`. A failed sweep query throws.
 */
export async function runBackfill(
  pool: Pool,
  starts: Pick<StartScheduler, "fire" | "idle">,
  { lookbackDays, batch = SWEEP_BATCH, signal, drain }: BackfillOptions,
): Promise<BackfillResult> {
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
  let stuck = 0;
  for (;;) {
    const before = seen.size;
    const asked = await sweepStaleUploads({
      pool,
      starts: once,
      olderThanMs: STALE_UPLOAD_MS,
      lookbackMs: lookbackDays * DAY_MS,
      limit,
      rethrow: true,
      ...(signal && { signal }),
    });
    await starts.idle();
    if (asked < limit || signal?.aborted) return { fired: seen.size, incomplete: false };
    if (seen.size > before) {
      stuck = 0;
      continue;
    }
    // A full batch with nothing new: the status rows may just lag behind the starts. Let the feed catch up and ask again.
    if (++stuck > MAX_STUCK_RETRIES) return { fired: seen.size, incomplete: true };
    await drain?.();
  }
}
