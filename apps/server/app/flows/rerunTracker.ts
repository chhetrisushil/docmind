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
  /**
   * Forgets a run whose end the event feed has already recorded. Loom settles the handle only after its post-terminal
   * housekeeping (inbox retire, checkpoint, lease release), so without this a read between the recorded end and the
   * settle would still answer `running`. Unknown ids are fine; the handle's settle later is a no-op.
   */
  end(executionId: string): void;
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

/** How many ends that beat their track() are remembered. */
const MAX_ENDED_EARLY = 256;

export function rerunTracker(): RerunTracker {
  const inFlight = new Map<string, Set<string>>();
  const keyOfExecution = new Map<string, string>();
  const forget = (key: string, set: Set<string>, executionId: string) => {
    set.delete(executionId);
    if (keyOfExecution.get(executionId) === key) keyOfExecution.delete(executionId);
    if (set.size === 0 && inFlight.get(key) === set) inFlight.delete(key);
  };
  // Ends that arrived before their track() (the event feed can beat the start's own return): a late track() of the same
  // id is dropped. Bounded, oldest first out.
  const endedEarly = new Set<string>();
  const lastRerun = new Map<string, number>();
  const tails = new Map<string, Promise<unknown>>();
  const running = (key: string) => (inFlight.get(key)?.size ?? 0) > 0;
  return {
    track(key, executionId, handle) {
      if (endedEarly.delete(executionId)) return;
      if (typeof handle.waitForCompletion !== "function") return;
      const set = inFlight.get(key) ?? new Set<string>();
      inFlight.set(key, set);
      set.add(executionId);
      keyOfExecution.set(executionId, key);
      void handle
        .waitForCompletion()
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => forget(key, set, executionId));
    },
    running,
    end(executionId) {
      const key = keyOfExecution.get(executionId);
      const set = key === undefined ? undefined : inFlight.get(key);
      if (key !== undefined && set) forget(key, set, executionId);
      else {
        keyOfExecution.delete(executionId);
        endedEarly.add(executionId);
        if (endedEarly.size > MAX_ENDED_EARLY)
          endedEarly.delete(endedEarly.values().next().value as string);
      }
    },
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
