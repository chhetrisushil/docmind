import { SWEEP_EVERY_MS, type SweepArgs, sweepStaleUploads } from "./sweep";

export interface Sweeper {
  /** Stops the timer and resolves once a run in progress has finished (it fires nothing after this). */
  stop(): Promise<void>;
}

/** One sweep at a time: a tick that finds the previous run still going is skipped. The timer is unref'd. */
export function startSweeper(args: Omit<SweepArgs, "signal">, everyMs = SWEEP_EVERY_MS): Sweeper {
  const stopping = new AbortController();
  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running !== null || stopping.signal.aborted) return;
    const run = sweepStaleUploads({ ...args, signal: stopping.signal }).finally(() => {
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
