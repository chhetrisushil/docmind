import type { ExecutionHandle } from "@loom/workflow-runtime";

/** `-r<n>`: the execution-id patterns (status/model.ts, visualize-turn/ids.ts) allow 3 digits. */
export const MAX_RERUNS = 999;

export type RerunProbe<H> = { kind: "started"; rerun: number; handle: H } | { kind: "running" };

/**
 * What both visuals starters (document and turn) share for on-demand re-runs: the executions this process started and has
 * not seen end (a key is "running" while any is open), the highest `-r<n>` this process took, a per-key lock so two
 * concurrent requests never start two runs, and the probe that takes the next free `-r<n>`.
 */
export interface RerunTracker {
  /** Remembers the run until it ends (a failed run frees the key too). A handle without `waitForCompletion` is not tracked. */
  track(key: string, executionId: string, handle: ExecutionHandle): void;
  running(key: string): boolean;
  /** The highest re-run number this process took for the key (0: none). */
  last(key: string): number;
  /** Runs `fn` after every earlier call for the same key has finished (a failure of one does not block the next). */
  exclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Takes the next free number above `max(floor, last(key))`: `start(n)` answers a handle, or null when Loom already has the
   * id (then the next number is tried, after re-checking that no run of the key is in flight). Answers `running` when a run
   * is in flight or every number is taken, so the caller never sees a 500 for it.
   */
  probe<H extends ExecutionHandle>(
    key: string,
    floor: number,
    start: (n: number) => Promise<H | null>,
  ): Promise<RerunProbe<H>>;
}

export function rerunTracker(): RerunTracker {
  const inFlight = new Map<string, Set<string>>();
  const lastRerun = new Map<string, number>();
  const tails = new Map<string, Promise<unknown>>();
  const running = (key: string) => (inFlight.get(key)?.size ?? 0) > 0;
  return {
    track(key, executionId, handle) {
      if (typeof handle.waitForCompletion !== "function") return;
      const set = inFlight.get(key) ?? new Set<string>();
      inFlight.set(key, set);
      set.add(executionId);
      void handle
        .waitForCompletion()
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          set.delete(executionId);
          if (set.size === 0 && inFlight.get(key) === set) inFlight.delete(key);
        });
    },
    running,
    last: (key) => lastRerun.get(key) ?? 0,
    exclusive(key, fn) {
      const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return run;
    },
    async probe(key, floor, start) {
      for (let n = Math.max(floor, lastRerun.get(key) ?? 0) + 1; n <= MAX_RERUNS; n++) {
        const handle = await start(n);
        if (handle) {
          lastRerun.set(key, n);
          return { kind: "started", rerun: n, handle };
        }
        if (running(key)) return { kind: "running" }; // a run began while we probed
      }
      return { kind: "running" }; // every number is taken
    },
  };
}
