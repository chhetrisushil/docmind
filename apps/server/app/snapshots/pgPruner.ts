import { LogLifecycle } from "@loom/workflow-runtime";
import { pgSessionLock } from "../db/sessionLock";
import type { DurableStorage } from "../storage";
import type { SnapshotPruneDeps } from "./pruner";

/** The session advisory lock one sweep holds, on the Loom database (ADR 0134 D6: one pruner per execution). */
export const SNAPSHOT_PRUNE_LOCK_KEY = "docmind:snapshot-prune";

/**
 * The production pruner: Loom's `LogLifecycle.pruneSnapshots(id, { keepLatest: 1 })` over the RAW stores, which
 * reads the log's structure and deletes snapshot rows by sequence without opening a sealed payload or state.
 *
 * This lifecycle has NO `compactionExempt`, on purpose: the app's (config.ts) exempts the ingest and chat
 * executions from COMPACTION (the read models fold their logs from the first event; a conversation parks on its
 * inbox), and Loom's `pruneSnapshots` treats an exempt execution as held. Pruning snapshots removes no event, so
 * neither reason applies, and Loom still never deletes the latest snapshot, a compacted log's checkpoint or a
 * fork point. The app's exemption, and so the refusal to compact, is unchanged.
 *
 * What safety rests on: per Loom ADR 0134 D6 two prunes on one execution are harmless; the dangerous combination
 * is compact-vs-prune, and that is excluded because chats are never compacted (the app's `compactionExempt`
 * refuses it). The advisory lock is defence in depth and avoids duplicate load. If `compactionExempt` ever gains
 * a legal-hold meaning ("a hold also holds its snapshots"), this lifecycle must honour it.
 */
export function snapshotPruneDeps(
  durable: Pick<DurableStorage, "raw" | "pool">,
): SnapshotPruneDeps {
  const { eventStore, snapshotStore } = durable.raw;
  const list = eventStore.listExecutionsPage?.bind(eventStore);
  if (list === undefined)
    throw new TypeError("snapshot pruning: the event store cannot list executions");
  const lifecycle = new LogLifecycle(eventStore, snapshotStore, {});
  return {
    listExecutionsPage: (q) => list(q),
    prune: async (executionId) => {
      // Cheap pre-filter: an index-only read of the sequences, no state. With at most one snapshot there is
      // nothing to prune, and LogLifecycle would still read the whole log and the latest snapshot's state.
      // Skipping is always safe: Loom decides what goes.
      const seqs = await snapshotStore.listSequences?.(executionId);
      if (seqs !== undefined && seqs.length <= 1) return 0;
      return lifecycle.pruneSnapshots(executionId, { keepLatest: 1 });
    },
    lock: () => pgSessionLock(durable.pool, SNAPSHOT_PRUNE_LOCK_KEY, "snapshot prune lock"),
  };
}
