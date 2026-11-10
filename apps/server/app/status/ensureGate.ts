import { opaqueIds } from "../opaqueIds";

/** Tries of one `ensure` before the event is given up on (the key store or the database is down), and the pause before the second. */
export const ENSURE_ATTEMPTS = 4;
export const ENSURE_BACKOFF_MS = 250;

/**
 * Keeps a synchronous feed (Loom's `observability.onEvent`) in order PER HANDLE while a new-format id's user may not be cached yet.
 *
 * `gate(handle, run)` runs `run` at once, in the same tick, when the id has no handle (an old-format id never needs a key) or when its
 * handle is known and has no queued event. Otherwise `run` joins that handle's own lane, after `opaqueIds.ensure(handle)` has filled the
 * cache, so a later event of a user never overtakes an earlier one of the same user (every event of an execution shares its handle). Lanes
 * are independent: a cold handle in a key-store outage delays no other user's event and no old-format one. Nothing downstream orders events
 * across users: Loom's fold engine queues per execution, and the publish chain only needs one user's progress in order.
 * `ensure` answering false (nobody holds the handle: the user is erased) still runs: the fold then writes the neutral row an erased
 * user's execution gets. An `ensure` that THROWS is retried; if it keeps throwing, the error is reported once (class only, by `report`) and
 * `run` is NOT called, for that event or for the events of the same handle queued behind it (not retried again until its lane has drained):
 * a fold with an unknown user would store a row with no key and no scope, so the event is left for the next boot's catch-up, which folds
 * from the watermark and has the warm cache. It is never dropped silently. `report` throwing is swallowed: a lane never rejects.
 */
export function ensureGate(
  onError: (err: unknown) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const report = (err: unknown): void => {
    try {
      onError(err);
    } catch {
      // A throwing reporter must not skip the events queued behind this one.
    }
  };
  const lanes = new Map<string, Promise<void>>();
  /** Handles whose `ensure` gave up while their lane was busy: their later queued events are skipped without another round of retries. */
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
    if (handle === null || (!lanes.has(handle) && opaqueIds.known(handle))) {
      try {
        run();
      } catch (err) {
        report(err);
      }
      return;
    }
    const mine: Promise<void> = (lanes.get(handle) ?? Promise.resolve())
      .then(async () => {
        if (!opaqueIds.known(handle) && (failed.has(handle) || !(await ensured(handle)))) return;
        run();
      })
      .catch(report)
      .finally(() => {
        if (lanes.get(handle) === mine) {
          lanes.delete(handle);
          failed.delete(handle);
        }
      });
    lanes.set(handle, mine);
  };
  /** Resolves when everything queued so far, in every lane, has run (shutdown and tests). */
  const idle = async (): Promise<void> => {
    while (lanes.size > 0) await Promise.all([...lanes.values()]);
  };
  return Object.assign(gate, { idle });
}
