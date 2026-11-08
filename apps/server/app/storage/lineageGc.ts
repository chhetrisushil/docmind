import { type ContentStore, sweepUnpinnedContent } from "@loom/plugin-content";
import type { SessionLock } from "../db/sessionLock";
import { StartupConfigError } from "../startupError";

export const DEFAULT_LINEAGE_GC_INTERVAL_MS = 86_400_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 30 * 24 * 3_600_000;

/**
 * A blob is only reclaimable once it has gone this long untouched (the store's own clock). It is the margin of
 * Loom's touch guard: a write (a `put`, a promote or a branch, each of which touches what it cites) that landed after
 * the sweep started or while the roots were being read is never erased, so the margin must dwarf any single commit
 * or the roots computation. A day is far beyond both, and a blob younger than that is never an orphan.
 */
export const LINEAGE_GC_GRACE_MS = 86_400_000;

/**
 * `DOCMIND_LINEAGE_GC_INTERVAL_MS` (default a day): how often the orphaned blobs of the visuals lineage are erased
 * from `lineage_content`. `0` turns the collector off. A bad value fails the boot; the message names the variable only.
 */
export function loadLineageGcIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DOCMIND_LINEAGE_GC_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_LINEAGE_GC_INTERVAL_MS;
  const value = Number(raw);
  const ok =
    /^\d+$/.test(raw) &&
    Number.isSafeInteger(value) &&
    (value === 0 || (value >= MIN_INTERVAL_MS && value <= MAX_INTERVAL_MS));
  if (!ok)
    throw new StartupConfigError(
      `DOCMIND_LINEAGE_GC_INTERVAL_MS must be 0 (off) or an integer from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS}`,
    );
  return value;
}

/** The ticker wakes this often (or every interval when shorter) and runs only when the last completed run is old enough. */
const TICK_MS = 3_600_000;

/** When recurring jobs last COMPLETED, durably and on the database's clock (`maintenance_runs`, migration 0031). */
export interface MaintenanceRuns {
  /** True when there is no row for `name`, or its last run is at least `everyMs` old by the database's clock. */
  due(name: string, everyMs: number): Promise<boolean>;
  /** Records a completed run, stamped by the database's clock. */
  markRun(name: string): Promise<void>;
}

/** What the collector needs; `pgLineageGc.ts` binds it to the lineage, `lineage_content` and Postgres. */
export interface LineageGcDeps {
  /**
   * EVERY content address the store's users must keep (Loom-UI `Lineage.pins`, keeping every version, over ALL lines of
   * all users: documents and chat turns). It must THROW, never end early, when it cannot be complete.
   */
  pins(): AsyncIterable<string>;
  /** The raw (ciphertext) store with the whole 1.3/1.4 sweep set. */
  store: Pick<
    ContentStore,
    "delete" | "deleteIfUntouchedSince" | "listPage" | "touchClock" | "touch"
  >;
  /** The cross-replica lock of a run; null when another replica holds it. */
  lock(): Promise<SessionLock | null>;
  /**
   * When set, a run happens only if `runs.due(...)` (checked UNDER the lock, so two replicas make one run), and is
   * recorded only after a run that completed: a refusal or a failure retries on the next tick.
   */
  schedule?: { name: string; everyMs: number; runs: MaintenanceRuns };
  /** Test seam: the margin. */
  graceMs?: number;
  /** Test seam: the log clock handed to Loom (the touch guard runs on the store's clock). */
  now?: () => number;
}

/** Why a run deleted nothing (fixed labels, never an id or an address). */
export type LineageGcRefusal =
  /** The root set could not be completed (a line failed to read, fold or open): the error class is in `failedByClass`. */
  | "roots-incomplete"
  /** No roots at all: an empty set is indistinguishable from a broken enumeration, so nothing is erased. */
  | "no-roots"
  /** Loom's sweep refused or failed before or while erasing: the class is in `failedByClass`. */
  | "sweep-failed"
  /** The store's clock could not be read: the grace cannot be measured. */
  | "no-clock"
  /** The last-run record could not be read or written: no run is attempted (or, after a run, it is retried). */
  | "schedule-unavailable"
  /** Aborted (shutdown), or the lock was lost, before or during the erasing sweep. */
  | "stopped";

/** Counts only, so it can be logged. */
export interface LineageGcReport {
  /** Another replica held the lock: nothing was looked at. */
  skipped: boolean;
  /** The last completed run is younger than the interval: nothing was looked at. */
  notDue?: boolean;
  /** Set when the run deleted nothing on purpose (fail closed). */
  refused?: LineageGcRefusal;
  /** Distinct addresses the lines (and what they embed) keep. */
  roots: number;
  /** Blobs erased. */
  reclaimed: number;
  /** Erasures Loom's guard refused because the blob was touched after the cutoff: they survived. */
  keptByTouch: number;
  failed: number;
  /** Failures by error class name (never a message), so a store-wide fault is one entry. */
  failedByClass: Record<string, number>;
}

const className = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

/**
 * One collection, under the cross-replica lock. FAIL CLOSED, in this order:
 *  1. The roots are read to the end into a set BEFORE Loom's sweep starts (the cutoff is read first, so a blob
 *     touched while they were read survives). Any error from `pins()` (a line that fails to read, fold or open, other
 *     than a confirmed erasure, which `pins()` itself skips), an abort or a lost lock means NOTHING is erased.
 *  2. An empty root set erases nothing.
 *  3. Loom's `sweepUnpinnedContent` then erases only orphans (no event store is scanned: see `contentUsers.test.ts`
 *     for why none cites this store), only through `deleteIfUntouchedSince`, only with `{ completeScan: true }`, and
 *     only blobs untouched since the cutoff; it throws before reading anything if the store lacks `touch`,
 *     `touchClock` or the margin is under a minute.
 * Never rethrows a failure of the run itself: it is counted by class and the next tick tries again.
 */
export async function collectLineageContent(
  deps: LineageGcDeps,
  signal?: AbortSignal,
): Promise<LineageGcReport> {
  const report: LineageGcReport = {
    skipped: false,
    roots: 0,
    reclaimed: 0,
    keptByTouch: 0,
    failed: 0,
    failedByClass: {},
  };
  const fail = (refused: LineageGcRefusal, err: unknown): LineageGcReport => {
    const cls = className(err);
    report.refused = refused;
    report.failed += 1;
    report.failedByClass[cls] = (report.failedByClass[cls] ?? 0) + 1;
    return report;
  };
  const release = await deps.lock();
  if (release === null) return { ...report, skipped: true };
  try {
    const graceMs = deps.graceMs ?? LINEAGE_GC_GRACE_MS;
    const stopped = () => signal?.aborted === true || release.lost?.aborted === true;
    if (deps.schedule) {
      try {
        if (!(await deps.schedule.runs.due(deps.schedule.name, deps.schedule.everyMs)))
          return { ...report, notDue: true };
      } catch (err) {
        return fail("schedule-unavailable", err);
      }
      report.notDue = false;
    }
    const roots = new Set<string>();
    let touchedBefore: number;
    try {
      // Read BEFORE the roots: whatever is cited, put or touched after this instant is newer than the cutoff.
      touchedBefore = (await deps.store.touchClock?.()) ?? Number.NaN;
      if (!Number.isFinite(touchedBefore)) throw new TypeError("the store has no clock");
      touchedBefore -= graceMs;
    } catch (err) {
      return fail("no-clock", err);
    }
    try {
      for await (const address of deps.pins()) {
        if (stopped()) {
          report.refused = "stopped";
          return report;
        }
        roots.add(address);
      }
    } catch (err) {
      if (stopped()) {
        report.refused = "stopped"; // a shutdown that broke the reads is not a fault
        return report;
      }
      return fail("roots-incomplete", err);
    }
    report.roots = roots.size;
    if (roots.size === 0) {
      report.refused = "no-roots";
      return report;
    }
    if (stopped()) {
      report.refused = "stopped";
      return report;
    }
    try {
      const swept = await sweepUnpinnedContent({
        eventStores: [],
        pinnedEventTypes: [],
        contentStore: deps.store,
        olderThanMs: graceMs,
        touchedBefore,
        now: (deps.now ?? Date.now)(),
        roots: async function* () {
          yield* roots;
        },
        reclaimOrphans: { completeScan: true },
      });
      report.reclaimed = swept.orphansReclaimed.length + swept.reclaimed.length;
      report.keptByTouch = swept.keptByTouch;
    } catch (err) {
      if (stopped()) {
        report.refused = "stopped"; // Loom's sweep takes no signal: a shutdown that broke it is not a fault
        return report;
      }
      return fail("sweep-failed", err);
    }
    if (deps.schedule) {
      try {
        await deps.schedule.runs.markRun(deps.schedule.name);
      } catch (err) {
        fail("schedule-unavailable", err); // the run completed; it is retried (idempotent) on the next tick
      }
    }
    return report;
  } finally {
    await release();
  }
}

export interface LineageGc {
  /** Stops the timer and resolves once a run in progress has finished. */
  stop(): Promise<void>;
}

/**
 * Ticks every `min(everyMs, 1 h)`; each tick runs only when the last COMPLETED run (durable, `deps.schedule`) is at least
 * `everyMs` old, so a service redeployed more often than the interval still collects. A tick during a run is skipped,
 * and a tick that is not due logs nothing. Unref'd.
 */
export function startLineageGc(deps: LineageGcDeps, everyMs: number): LineageGc {
  const stopping = new AbortController();
  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running !== null || stopping.signal.aborted) return;
    const started = Date.now();
    running = collectLineageContent(deps, stopping.signal)
      .then((r) => {
        if (r.notDue) return;
        if (r.skipped) console.info("lineage gc skipped: another replica holds the lock");
        else
          console.info("lineage gc", {
            refused: r.refused ?? null,
            roots: r.roots,
            reclaimed: r.reclaimed,
            keptByTouch: r.keptByTouch,
            failed: r.failed,
            failedByClass: r.failedByClass,
            ms: Date.now() - started,
          });
      })
      .catch((err: unknown) => console.error("lineage gc failed", className(err)))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, Math.min(everyMs, TICK_MS));
  timer.unref();
  console.info("lineage gc enabled", { everyMs });
  return {
    async stop() {
      clearInterval(timer);
      stopping.abort();
      await running;
    },
  };
}
