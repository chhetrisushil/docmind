import type { ExecutionEnumerable, LeaseStore } from "@loom/event-runtime";
import {
  FlowCodeMismatchError,
  type WorkflowRuntime,
  recoverAbandoned,
} from "@loom/workflow-runtime";
import {
  FLOW_MISMATCH_REASON,
  RECOVERY_EXHAUSTED_REASON,
  isIngestExecution,
} from "../../status/model";

/** How often the periodic pass looks for executions whose driver is gone. */
export const RECOVERY_INTERVAL_MS = 60_000;
/**
 * Consecutive re-drives of one execution that made no progress before recovery gives it up. Counted
 * from the log (Loom's `maxRecoveries`), so it holds across restarts and nodes, and it counts a
 * graceful restart too: an execution interrupted by this many deploys in a row, mid-step, fails.
 */
export const MAX_RECOVERIES = 3;
/**
 * The periodic pass leaves an execution alone until its log has been quiet this long, a margin for
 * a peer node that started it and has not yet taken its lease. The boot pass uses 0: the lease
 * store already vetoes any execution a live driver heartbeats.
 */
export const ABANDON_GRACE_MS = 60_000;

/**
 * Every this-many periodic passes scan the whole log instead of the expired leases (hourly at the
 * default interval): a re-drive that failed before its claim won leaves no expired lease to find.
 */
export const FULL_SCAN_EVERY = 60;

const errorClass = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

export interface RecoverOptions {
  graceMs: number;
  maxRecoveries?: number;
  now?: () => number;
  /**
   * Scan only the expired leases (a crash leaves them) instead of every execution. The boot pass
   * scans everything, because a graceful shutdown releases (deletes) its leases.
   */
  leases?: { store: LeaseStore; owner: string };
}

/**
 * One recovery pass over the ingest executions whose driver is gone (a crash, or a shutdown that
 * released its leases). Loom resumes each from its log, with the principal it rehydrates from the
 * sealed start record, so the step re-runs under the original owner and tenant.
 *
 * Executions that cannot be resumed are given up, because nothing else would ever move them out of
 * `parsing`: Loom cannot fail an execution from outside, so recovery cancels it with a fixed reason
 * the status model folds to `failed` / `internal` (see UNRECOVERABLE_REASONS):
 *  - the crash-loop bound was reached (`MAX_RECOVERIES`);
 *  - the flow's identity changed under it (`FlowCodeMismatchError`: a deploy changed the steps or
 *    their retry policy). Rule (a): the user deletes the document and uploads it again (a duplicate
 *    upload of a failed document starts nothing); a restart under the next generation waits for the
 *    retry task.
 * Only the error class is logged, never an id.
 */
export async function recoverIngest(
  runtime: WorkflowRuntime,
  source: ExecutionEnumerable,
  { graceMs, maxRecoveries = MAX_RECOVERIES, now = Date.now, leases }: RecoverOptions,
) {
  const ending: Promise<unknown>[] = [];
  const giveUp = (executionId: string, reason: string) => {
    ending.push(
      runtime
        .cancel(executionId, reason, runtime.systemOptions())
        .catch((err: unknown) => console.error("ingest recovery cancel failed", errorClass(err))),
    );
  };
  const summary = await recoverAbandoned(runtime, {
    ...(leases ? { leases } : { source }),
    maxRecoveries,
    isAbandoned: (c) => isIngestExecution(c.executionId) && now() - c.updatedAt >= graceMs,
    onExhausted: (id) => giveUp(id, RECOVERY_EXHAUSTED_REASON),
    onError: (id, err) =>
      err instanceof FlowCodeMismatchError
        ? giveUp(id, FLOW_MISMATCH_REASON)
        : console.error("ingest recovery failed", errorClass(err)),
  });
  await Promise.all(ending);
  return summary;
}

export interface Recovery {
  /** Stops the periodic pass. A pass in flight is not awaited: it can be waiting on a re-driven step. */
  stop(): void;
  /** Settles when the pass now running (if any) has. */
  idle(): Promise<void>;
}

/**
 * Starts the boot pass (not awaited: a pass settles each execution it re-drives, which can take a
 * whole parse, and the server must not wait to listen) and then one pass per `intervalMs` on an
 * unref'd timer. Passes never overlap, and a pass that throws is logged by class and forgotten.
 */
export function startRecovery(
  runtime: WorkflowRuntime,
  source: ExecutionEnumerable,
  {
    intervalMs = RECOVERY_INTERVAL_MS,
    now,
    leases,
  }: { intervalMs?: number; now?: () => number; leases?: RecoverOptions["leases"] } = {},
): Recovery {
  let running: Promise<void> | undefined;
  let stopped = false;
  let periodic = 0; // passes the timer has started
  const pass = (graceMs: number, scan?: RecoverOptions["leases"]) => {
    if (stopped || running) return;
    running = recoverIngest(runtime, source, {
      graceMs,
      ...(now && { now }),
      ...(scan && { leases: scan }),
    })
      .then(() => undefined)
      .catch((err: unknown) => console.error("ingest recovery failed", errorClass(err)))
      .finally(() => {
        running = undefined;
      });
  };
  pass(0);
  const timer = setInterval(() => {
    if (stopped || running) return;
    // Lease mode finds a crash's expired leases only; ghost lease rows (a crash between taking the lease
    // and the first append) are not covered until the next full scan. Carried, not fixed.
    periodic++;
    pass(ABANDON_GRACE_MS, periodic % FULL_SCAN_EVERY === 0 ? undefined : leases);
  }, intervalMs);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    idle: async () => {
      await running;
    },
  };
}
