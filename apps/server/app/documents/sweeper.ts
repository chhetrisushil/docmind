import {
  SWEEP_EVERY_MS,
  SWEEP_ORPHAN_EVERY_TICKS,
  type StatusForgetter,
  type SweepArgs,
  sweepOrphanStatuses,
  sweepStaleUploads,
} from "./sweep";

export interface Sweeper {
  /** Stops the timer and resolves once a run in progress has finished (it fires nothing after this). */
  stop(): Promise<void>;
}

/** One sweep at a time: a tick that finds the previous run still going is skipped. The timer is unref'd. */
export function startSweeper(
  args: Omit<SweepArgs, "signal"> & { status?: StatusForgetter },
  everyMs = SWEEP_EVERY_MS,
): Sweeper {
  const stopping = new AbortController();
  let running: Promise<unknown> | null = null;
  let ticks = 0;
  const tick = () => {
    if (running !== null || stopping.signal.aborted) return;
    const { status, ...stale } = args;
    const signal = stopping.signal;
    // The orphan scan reads both tables in full, so it runs on the first tick and then every Nth.
    const orphans = status !== undefined && ticks++ % SWEEP_ORPHAN_EVERY_TICKS === 0;
    const run = (async () => {
      await sweepStaleUploads({ ...stale, signal });
      if (orphans)
        await sweepOrphanStatuses({ pool: stale.pool, status, limit: stale.limit, signal });
    })().finally(() => {
      running = null;
    });
    running = run;
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      stopping.abort();
      await running;
    },
  };
}
