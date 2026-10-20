import type { ExecutionEnumerable, LeaseStore } from "@loom/event-runtime";
import {
  FlowCodeMismatchError,
  type WorkflowRuntime,
  collectGhostLeases,
  recoverAbandoned,
} from "@loom/workflow-runtime";
import { isRecoverableChatExecution } from "../../chats/ids";
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

/**
 * Loom's ghost-lease GC examines this many expired leases per call and rotates its window one page
 * per call that collects nothing, so a ghost behind many expired orphans takes one call per page.
 */
const GHOST_GC_BATCH = 100;
/** Loom's rotation is at most 64 pages deep; the pass never runs more rounds than this. */
const GHOST_GC_MAX_ROUNDS = 140;

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
  /** Which executions this pass may re-drive; default ingest executions. */
  owns?: (executionId: string) => boolean;
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
  {
    graceMs,
    maxRecoveries = MAX_RECOVERIES,
    now = Date.now,
    leases,
    owns = isIngestExecution,
  }: RecoverOptions,
) {
  if (!leases) {
    // A full scan also clears ghost leases (a crash between taking a lease and the first append): they
    // have no stream, so no pass would ever re-drive or remove them, and lease mode lists them forever.
    // Loom's own GC runs from TimerService, which this server runs only when chat is composed; ingest-only builds rely on this pass.
    try {
      const store = runtime.leaseKeeper?.leaseStore;
      // One round per page of expired leases, until that many rounds in a row collect nothing.
      const expired = store ? (await store.expired(undefined, GHOST_GC_BATCH * 64)).length : 0;
      const pages = Math.ceil(expired / GHOST_GC_BATCH);
      let empty = 0;
      for (let round = 0; pages > 0 && round < GHOST_GC_MAX_ROUNDS; round++) {
        if ((await collectGhostLeases(runtime, { limit: GHOST_GC_BATCH })) > 0) empty = 0;
        else if (++empty >= pages) break;
      }
    } catch (err) {
      console.error("ghost lease gc failed", errorClass(err));
    }
  }
  const ending: Promise<unknown>[] = [];
  const giveUp = (executionId: string, reason: string) => {
    ending.push(
      runtime
        .cancel(executionId, reason, runtime.systemOptions())
        .catch((err: unknown) => console.error("recovery cancel failed", errorClass(err))),
    );
  };
  // An ingest flow whose identity changed is given up. A chat is NOT: cancelling would end a user's conversation
  // for good. It is logged and left, and every pass logs it again until a build that still carries the old flow
  // version resumes it. Migration plan: register the previous chat flow version beside the new one.
  const mismatch = (id: string, err: unknown) =>
    isRecoverableChatExecution(id)
      ? console.error("recovery left a chat on an old flow version", errorClass(err))
      : giveUp(id, FLOW_MISMATCH_REASON);
  const summary = await recoverAbandoned(runtime, {
    ...(leases ? { leases } : { source }),
    maxRecoveries,
    isAbandoned: (c) => owns(c.executionId) && now() - c.updatedAt >= graceMs,
    onExhausted: (id) => giveUp(id, RECOVERY_EXHAUSTED_REASON),
    onError: (id, err) =>
      err instanceof FlowCodeMismatchError
        ? mismatch(id, err)
        : console.error("recovery failed", errorClass(err)),
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
    owns,
  }: {
    intervalMs?: number;
    now?: () => number;
    leases?: RecoverOptions["leases"];
    owns?: RecoverOptions["owns"];
  } = {},
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
      ...(owns && { owns }),
    })
      .then(() => undefined)
      .catch((err: unknown) => console.error("recovery failed", errorClass(err)))
      .finally(() => {
        running = undefined;
      });
  };
  pass(0);
  const timer = setInterval(() => {
    if (stopped || running) return;
    // Lease mode finds a crash's expired leases only; ghost lease rows are cleared by the next full scan.
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
