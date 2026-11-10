import { opaqueIds } from "../opaqueIds";

/** Tries of one `ensure` before the event is given up on (the key store or the database is down), and the pause before the second. */
export const ENSURE_ATTEMPTS = 4;
export const ENSURE_BACKOFF_MS = 250;

/**
 * Keeps a synchronous feed (Loom's `observability.onEvent`) in log order while a new-format id's user may not be cached yet.
 *
 * `gate(handle, run)` runs `run` at once, in the same tick, when nothing is queued and the event's user is known (or the id has no
 * handle: an old-format id never needs a key). Otherwise `run` is queued behind everything already queued, after `opaqueIds.ensure(handle)`
 * has filled the cache, so a later event of a known user never overtakes an earlier one of a cold user. `ensure` answering false
 * (nobody holds the handle: the user is erased) still runs: the fold then writes the neutral row an erased user's execution gets.
 * An `ensure` that THROWS is retried; if it keeps throwing, the error is reported once (class only, by `report`) and `run` is NOT called, for
 * that event or for the events of the same user queued behind it (a user that failed is not retried again until the queue has drained): a
 * fold with an unknown user would store a row with no key and no scope, which every reader skips, so the event is left for the next
 * boot's catch-up, which folds from the watermark and has the warm cache. It is never dropped silently.
 */
export function ensureGate(
  report: (err: unknown) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let tail: Promise<void> | null = null;
  /** Handles whose `ensure` gave up during the current queue: their later queued events are skipped without another round of retries. */
  const failed = new Set<string>();
  const ensured = async (handle: string): Promise<boolean> => {
    let last: unknown;
    for (let attempt = 1; attempt <= ENSURE_ATTEMPTS; attempt++) {
      try {
        await opaqueIds.ensure(handle);
        return true;
      } catch (err) {
        last = err;
        if (attempt < ENSURE_ATTEMPTS) await sleep(ENSURE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
    failed.add(handle);
    report(last);
    return false;
  };
  const gate = (handle: string | null, run: () => void): void => {
    if (tail === null && (handle === null || opaqueIds.known(handle))) {
      run();
      return;
    }
    const mine: Promise<void> = (tail ?? Promise.resolve())
      .then(async () => {
        if (handle !== null && !opaqueIds.known(handle)) {
          if (failed.has(handle) || !(await ensured(handle))) return;
        }
        run();
      })
      .catch(report)
      .finally(() => {
        if (tail === mine) {
          tail = null;
          failed.clear();
        }
      });
    tail = mine;
  };
  /** Resolves when everything queued so far has run (shutdown and tests). */
  const idle = async (): Promise<void> => {
    while (tail !== null) await tail;
  };
  return Object.assign(gate, { idle });
}
