import type { ExecutionEnumerable } from "@loom/event-runtime";
import {
  FlowCodeMismatchError,
  type WorkflowRuntime,
  recoverAbandoned,
} from "@loom/workflow-runtime";
import { UNRECOVERABLE_REASONS, isIngestExecution } from "../../status/model";

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

const [EXHAUSTED, MISMATCH] = UNRECOVERABLE_REASONS;

const errorClass = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

export interface RecoverOptions {
  graceMs: number;
  maxRecoveries?: number;
  now?: () => number;
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
 *    their retry policy). Rule (a): the user re-uploads; a restart under the next generation is not
 *    taken because the old content's start is not replayable under the new definition.
 * Only the error class is logged, never an id.
 */
export async function recoverIngest(
  runtime: WorkflowRuntime,
  source: ExecutionEnumerable,
  { graceMs, maxRecoveries = MAX_RECOVERIES, now = Date.now }: RecoverOptions,
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
    source,
    maxRecoveries,
    isAbandoned: (c) => isIngestExecution(c.executionId) && now() - c.updatedAt >= graceMs,
    onExhausted: (id) => giveUp(id, EXHAUSTED),
    onError: (id, err) =>
      err instanceof FlowCodeMismatchError
        ? giveUp(id, MISMATCH)
        : console.error("ingest recovery failed", errorClass(err)),
  });
  await Promise.all(ending);
  return summary;
}
