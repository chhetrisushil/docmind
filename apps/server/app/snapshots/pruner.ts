import { isChatExecution } from "../chats/activity";
import type { SessionLock } from "../db/sessionLock";
import { USER_ID_PREFIXES } from "../opaqueIds";
import { StartupConfigError } from "../startupError";

export const DEFAULT_SNAPSHOT_PRUNE_INTERVAL_MS = 3_600_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 7 * 24 * 3_600_000;
const PAGE = 500;

/**
 * `DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS` (default an hour): how often the superseded snapshots of the chat
 * conversations are pruned. `0` turns the pruner off. A bad value fails the boot; the message names the
 * variable only.
 */
export function loadSnapshotPruneIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_SNAPSHOT_PRUNE_INTERVAL_MS;
  const value = Number(raw);
  const ok =
    /^\d+$/.test(raw) &&
    Number.isSafeInteger(value) &&
    (value === 0 || (value >= MIN_INTERVAL_MS && value <= MAX_INTERVAL_MS));
  if (!ok)
    throw new StartupConfigError(
      `DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS must be 0 (off) or an integer from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS}`,
    );
  return value;
}

/** What a sweep needs; `pgPruner.ts` binds it to Loom and Postgres. */
export interface SnapshotPruneDeps {
  listExecutionsPage(q: {
    cursor?: string;
    limit: number;
  }): Promise<{ executionIds: string[]; nextCursor?: string }>;
  /** Deletes the execution's superseded snapshots; resolves with how many. */
  prune(executionId: string): Promise<number>;
  /** The cross-replica lock of a sweep; null when another replica holds it. */
  lock(): Promise<SessionLock | null>;
}

/** Counts only, so it can be logged. */
export interface SweepReport {
  executions: number;
  deleted: number;
  failed: number;
  /** Failures by error class name (never a message or an id), so a store-wide fault is one entry, not N log lines. */
  failedByClass: Record<string, number>;
  /** Another replica held the lock: nothing was looked at. */
  skipped: boolean;
  /** Aborted, or the lock was lost, before the last execution. */
  stopped: boolean;
}

const className = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

/**
 * One sweep: under the lock, page the `u_` executions and then the `h_` executions and prune each chat conversation (of either format), one at a time. A failure
 * on one execution is counted by error class (the caller logs one line per sweep); the sweep carries on. A failed listing ends the sweep (rethrown).
 */
export async function sweepChatSnapshots(
  deps: SnapshotPruneDeps,
  signal?: AbortSignal,
  pageSize = PAGE,
): Promise<SweepReport> {
  const report: SweepReport = {
    executions: 0,
    deleted: 0,
    failed: 0,
    failedByClass: {},
    skipped: false,
    stopped: false,
  };
  const release = await deps.lock();
  if (release === null) return { ...report, skipped: true };
  try {
    // The two id formats are two runs of the log (`u_<uuid>` before the deploy, `h_<handle>` after); the log pages ids in code-point order.
    for (const prefix of USER_ID_PREFIXES) {
      let cursor: string = prefix; // strictly-after: every id of the run sorts after the bare prefix
      scan: for (;;) {
        const page = await deps.listExecutionsPage({ cursor, limit: pageSize });
        for (const executionId of page.executionIds) {
          if (!executionId.startsWith(prefix)) break scan; // past this prefix's range
          if (!isChatExecution(executionId)) continue;
          if (signal?.aborted || release.lost?.aborted) {
            report.stopped = true;
            return report;
          }
          report.executions += 1;
          try {
            report.deleted += await deps.prune(executionId);
          } catch (err) {
            report.failed += 1;
            const cls = className(err);
            report.failedByClass[cls] = (report.failedByClass[cls] ?? 0) + 1;
          }
        }
        if (page.nextCursor === undefined) break;
        cursor = page.nextCursor;
      }
    }
    return report;
  } finally {
    await release();
  }
}

export interface SnapshotPruner {
  /** Stops the timer and resolves once a sweep in progress has finished its current execution. */
  stop(): Promise<void>;
}

/** One sweep per `everyMs`, the first one interval after start; a tick during a sweep is skipped. Unref'd. */
export function startSnapshotPruner(deps: SnapshotPruneDeps, everyMs: number): SnapshotPruner {
  const stopping = new AbortController();
  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running !== null || stopping.signal.aborted) return;
    const started = Date.now();
    running = sweepChatSnapshots(deps, stopping.signal)
      .then((r) => {
        if (r.skipped) console.info("snapshot prune skipped: another replica holds the lock");
        else
          console.info("snapshot prune", {
            executions: r.executions,
            deleted: r.deleted,
            failed: r.failed,
            failedByClass: r.failedByClass,
            stopped: r.stopped,
            ms: Date.now() - started,
          });
      })
      .catch((err: unknown) => console.error("snapshot prune failed", className(err)))
      .finally(() => {
        running = null;
      });
  };
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
