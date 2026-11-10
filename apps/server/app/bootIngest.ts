import { primeDecoy } from "@docmind/auth";
import type { Pool } from "pg";
import { bootServing } from "./boot";
import { isRecoverableChatExecution } from "./chats/ids";
import { closeSequence } from "./closeSequence";
import type { buildServer } from "./compose";
import { repairStoredExecutionIds } from "./documents/executionIds";
import { STALE_UPLOAD_MS, SWEEP_BATCH, SWEEP_LOOKBACK_MS } from "./documents/sweep";
import { startSweeper } from "./documents/sweeper";
import { hydrateSubjectIndex } from "./erasure/compliance";
import { type IngestWiring, closeIngest } from "./flows/ingest-document/limits";
import { startRecovery } from "./flows/ingest-document/recovery";
import { verifyVectors } from "./flows/ingest-document/verifyVectors";
import { isSuggestTagsExecution } from "./flows/suggest-tags/start";
import { isTurnVisualizeExecution } from "./flows/visualize-turn/ids";
import { opaqueIds } from "./opaqueIds";
import { SHUTDOWN_DRAIN_MS, drainWithin, runAll } from "./shutdown";
import { snapshotPruneDeps } from "./snapshots/pgPruner";
import { startSnapshotPruner } from "./snapshots/pruner";
import { bootStatus } from "./status/boot";
import { isIngestExecution, isVisualizeExecution } from "./status/model";
import type { DurableStorage } from "./storage";
import { startLineageGc } from "./storage/lineageGc";
import { lineageGcDeps } from "./storage/pgLineageGc";

const HOUR_MS = 60 * 60 * 1000;

/** The executions boot recovery re-drives: ingest, the visuals flows (document and turn), the chat's conversations and titles, and the on-demand tag suggestions. */
export const recoveryOwns = (id: string): boolean =>
  isIngestExecution(id) ||
  isVisualizeExecution(id) ||
  isTurnVisualizeExecution(id) ||
  isRecoverableChatExecution(id) ||
  isSuggestTagsExecution(id);

export interface BootIngestParts {
  built: ReturnType<typeof buildServer>;
  ingest: IngestWiring;
  durable: DurableStorage;
  pool: Pool;
  /** Binds the server. Omitted by callers that serve nothing (a script, or a test that listens itself later). */
  listen?: () => Promise<void>;
  /** Identifies this process's execution leases. */
  recoveryOwner: string;
  /**
   * Run the hourly session sweep and the upload sweeper (default true). A one-shot script passes false:
   * recovery still starts, but nothing recurs.
   */
  background?: boolean;
  /**
   * Stops the server accepting requests, runs `then` once it is drained (even if the drain fails), and
   * propagates a drain failure. Default: no server, so `then` runs at once.
   */
  /**
   * After SIGTERM, how long to keep serving normally, with `/readyz` at 503, before the drain starts
   * (`DOCMIND_SHUTDOWN_DELAY_MS`, default 0). It counts inside the caller's forced-exit deadline.
   */
  shutdownDelayMs?: number;
  /**
   * How often to prune the chat conversations' superseded snapshots (`DOCMIND_SNAPSHOT_PRUNE_INTERVAL_MS`,
   * loaded by `setupServer`). Default 0: off, so a script or a test stack that does not ask runs no pruner.
   * Only with `background`.
   */
  snapshotPruneIntervalMs?: number;
  /**
   * How often to erase the visuals lineage's orphaned blobs (`DOCMIND_LINEAGE_GC_INTERVAL_MS`, loaded by `setupServer`).
   * Default 0: off. Only with `background`.
   */
  lineageGcIntervalMs?: number;
  drainServer?: (then: () => Promise<void>) => Promise<void>;
}

/**
 * The one boot order for `main` and the acceptance stack: verify the schema fits the embedder, boot the
 * status model, hash the decoy, bind (when `listen` is given), and only then start recovery, the session
 * sweep, the upload sweeper and the snapshot pruner (a failed bind must not spend recovery budget). A failure before that
 * cleans up what the caller opened and rethrows. `stop()` runs the shutdown in the order that keeps it
 * safe and is idempotent; it does not close what `bootIngest` did not open the caller's way
 * (the blob root, the temp dir, the test database).
 */
export async function bootIngest(
  parts: BootIngestParts,
): Promise<{ stop(): Promise<void>; recoveryIdle(): Promise<void> }> {
  const {
    built,
    ingest,
    durable,
    pool,
    listen,
    recoveryOwner,
    background = true,
    shutdownDelayMs = 0,
    snapshotPruneIntervalMs = 0,
    lineageGcIntervalMs = 0,
  } = parts;
  const {
    app,
    lineageGc,
    store,
    throttle,
    starts,
    status,
    activity,
    vectors,
    readiness,
    events,
    chatStreams,
    detachStatusFeed,
    chat,
    titles,
    turns,
    suggestTags,
    visuals,
    eraser,
    erasureLocks,
  } = built;
  // `opaqueIds.install` is process-wide: remove this stack's cache only if it is still the installed one (a newer stack in the same process
  // owns the slot now, and stopping an older one must not strip it).
  const uninstallIds = async () => {
    if (opaqueIds.current() === built.ids) opaqueIds.install(undefined);
  };
  const cleanup = [
    () => closeIngest(ingest),
    () => app.close(),
    () => durable.close(),
    () => pool.end(),
    uninstallIds, // a failed boot must not leave id keys derived from live data keys installed
  ];

  // The schema (applied out of band by `pnpm db:migrate`) must fit the embedder before anything else starts.
  await verifyVectors(vectors, cleanup);
  // The id key cache is warmed before the status model boots, so before recovery, the fold or any observer reads a new-format id (R14). A
  // key-store outage fails the boot here (with the fixed label, never an id): nothing falls back to an old-format id.
  await bootStatus(
    {
      boot: async () => {
        // Counts only, so a slow boot on many users is explained (the cache is in memory).
        console.info("id keys warmed", { users: await built.ids.warm() });
      },
    },
    cleanup,
    "id keys",
  );
  // Register, then catch up on what the log holds, before anything is served (ADR 0132 D13).
  await bootStatus(status, cleanup);
  // An old pod never writes `documents.ingest_execution_id` or `visualize_execution_id` (migration 0038), so a document it ingested between the
  // migration job and its stop (deploys are recreate-only) has an old-format status row and no stored id: the stale-upload sweep would start a second ingest for it, and the ready and
  // visuals sweeps would never find it. The repair is idempotent (it only fills a NULL column from an existing status row) and runs here,
  // before recovery and every sweep. A failure is fatal with the fixed label: a sweep that lists on missing ids would double-start work.
  await bootStatus(
    {
      boot: async () => {
        // A count only, so a slow boot after a long rollout is explained.
        console.info("stored execution ids repaired", {
          columns: await repairStoredExecutionIds(pool),
        });
      },
    },
    cleanup,
    "stored execution ids",
  );
  // The session list falls back to created_at without this model, so its failure never blocks serving.
  await activity.boot().catch((err: unknown) => {
    console.error(
      "chat activity failed to boot; serving without it",
      err instanceof Error ? err.constructor.name : typeof err,
    );
  });
  // Loom's subject index is fed live only, so after a restart it knows none of the users' executions and an
  // erasure would answer "unknown" and shred nothing. Rebuild it from the log before anything is served. A failure
  // here is fatal: a server that cannot erase must not take requests (the error is the fixed label, never an id).
  const subjectIndex = app.subjectIndex;
  if (subjectIndex)
    await bootStatus(
      {
        boot: async () => {
          const executions = await hydrateSubjectIndex(durable.raw.eventStore, subjectIndex);
          // Counts only, so a slow boot on a large history is explained (the index is in memory).
          console.info("subject index hydrated", {
            subjects: subjectIndex.subjects().length,
            executions,
          });
        },
      },
      cleanup,
      "subject index",
    );
  // Only now may the timers run (the app was built with `autostart: false`; see `buildApp`).
  if (subjectIndex) app.start();
  // Hash the decoy now so the first unknown-email login is not measurably slower.
  await primeDecoy();

  const sweepAbort = new AbortController();
  let recovery!: ReturnType<typeof startRecovery>;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let uploadSweeper: ReturnType<typeof startSweeper> | undefined;
  let snapshotPruner: ReturnType<typeof startSnapshotPruner> | undefined;
  let lineageCollector: ReturnType<typeof startLineageGc> | undefined;
  const afterListen = () => {
    // Resume what the last process left running, then keep looking. Not awaited: the server must not wait to listen.
    recovery = startRecovery(app.runtime, durable.storage.eventStore, {
      // Ingest, the visuals flow, and the chat: a conversation mid-turn at a crash, and an interrupted title flow (P5).
      owns: recoveryOwns,
      // After the boot scan, a crash is found through its expired lease, not by reading every execution.
      ...(durable.storage.leaseStore && {
        leases: { store: durable.storage.leaseStore, owner: recoveryOwner },
      }),
    });
    // Visualize the documents that turned ready with no visualize execution (a crash between ready and its start, or
    // the role switched on later). After recovery has started, so a half-run execution is resumed, not restarted.
    // Not awaited; a fired start is joined to the shutdown through `visuals.idle()`.
    void visuals.sweep(sweepAbort.signal);
    // Resume erasures the last process left unfinished, after recovery has started (a cancelled-by-erasure
    // owner must not be re-driven by recovery first) and after the read models booted. Not awaited.
    void eraser?.resumeAll();
    eraser?.startRescan();
    if (!background) return;
    const sweep = () =>
      Promise.all([store.purgeExpiredSessions(), throttle.purge()]).catch((err: unknown) =>
        console.error(
          "session sweep failed",
          err instanceof Error ? err.constructor.name : typeof err,
        ),
      );
    void sweep();
    sweepTimer = setInterval(sweep, HOUR_MS);
    sweepTimer.unref();
    uploadSweeper = startSweeper({
      pool,
      starts,
      status,
      olderThanMs: STALE_UPLOAD_MS,
      lookbackMs: SWEEP_LOOKBACK_MS,
      limit: SWEEP_BATCH,
    });
    // The first sweep runs one interval from now, never during the boot (recovery and the index come first).
    if (snapshotPruneIntervalMs > 0)
      snapshotPruner = startSnapshotPruner(snapshotPruneDeps(durable), snapshotPruneIntervalMs);
    // Not while the visuals role is off: the lineage is only written by it, so there is nothing to collect.
    if (lineageGcIntervalMs > 0 && built.visualsOn)
      lineageCollector = startLineageGc(
        lineageGcDeps(lineageGc, durable.pool, pool, lineageGcIntervalMs),
        lineageGcIntervalMs,
      );
  };

  if (listen) {
    await bootServing({ bind: listen, cleanup: () => runAll(...cleanup), afterListen });
  } else {
    afterListen();
  }

  let stopping: Promise<void> | undefined;
  const stop = () => {
    // Readiness first (and the optional delay), then timers (sweepers and the snapshot pruner), then the open event streams (they never end on their own, so the server drain would
    // wait on them), then the server drain, then the close sequence.
    stopping ??= (async () => {
      // First of all: /readyz turns 503. Then, if a delay is set, everything else keeps running as normal
      // (the listener, the streams, the timers) so a balancer's next probes can see the 503 and stop routing;
      // only after that does the drain close the listener.
      readiness.beginShutdown();
      if (shutdownDelayMs > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, shutdownDelayMs));
      if (sweepTimer) clearInterval(sweepTimer);
      sweepAbort.abort(); // no visualize start may be fired once the drain begins
      recovery.stop();
      const sweeperStopped = uploadSweeper?.stop() ?? Promise.resolve(); // idempotent; no sweep may fire a start once the drain begins
      // A prune in progress finishes its current execution (one DELETE) and releases its lock connection to the
      // Loom pool, which closes later; it shares the sweeper's drain bound, so the deadline is unchanged.
      const prunerStopped = snapshotPruner?.stop() ?? Promise.resolve();
      const collectorStopped = lineageCollector?.stop() ?? Promise.resolve();
      events.closeAll();
      chatStreams?.closeAll();
      const close = async () => {
        // Let a sweep that is already running finish.
        await drainWithin(
          Promise.all([sweeperStopped, prunerStopped, collectorStopped]),
          SHUTDOWN_DRAIN_MS,
        );
        // The server has stopped accepting uploads; let every fired flow start settle, then close everything.
        await runAll(
          ...closeSequence({
            ...(eraser && { stopErasure: () => eraser.stop() }),
            ...(erasureLocks && { closeErasureLocks: () => erasureLocks.end() }),
            startsIdle: async () => {
              await starts.idle();
              await titles?.idle();
              await turns?.idle();
              await suggestTags?.idle();
              await visuals.idle();
            },
            closeIngest: () => closeIngest(ingest),
            ...(chat && { closeChat: () => chat.close() }),
            closeHeartbeat: () => app.runtime.closeHeartbeat(),
            detachStatusFeed,
            closeStatus: () =>
              runAll(
                () => status.close(),
                () => activity.close(),
              ),
            closeApp: () => app.close(),
            closeDurable: () => durable.close(),
            closeReadiness: () => readiness.close(),
            endPool: () => pool.end(),
          }),
          // The last closer: a later stack in this process must start cold, not inherit this cache (and a newer stack's cache stays).
          uninstallIds,
        );
      };
      await (parts.drainServer ?? ((then) => then()))(close);
    })();
    return stopping;
  };
  return { stop, recoveryIdle: () => recovery.idle() };
}
