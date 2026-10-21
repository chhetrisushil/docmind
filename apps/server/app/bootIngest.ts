import { primeDecoy } from "@docmind/auth";
import type { Pool } from "pg";
import { bootServing } from "./boot";
import { isRecoverableChatExecution } from "./chats/ids";
import { closeSequence } from "./closeSequence";
import type { buildServer } from "./compose";
import { STALE_UPLOAD_MS, SWEEP_BATCH, SWEEP_LOOKBACK_MS } from "./documents/sweep";
import { startSweeper } from "./documents/sweeper";
import { hydrateSubjectIndex } from "./erasure/compliance";
import { type IngestWiring, closeIngest } from "./flows/ingest-document/limits";
import { startRecovery } from "./flows/ingest-document/recovery";
import { verifyVectors } from "./flows/ingest-document/verifyVectors";
import { SHUTDOWN_DRAIN_MS, drainWithin, runAll } from "./shutdown";
import { bootStatus } from "./status/boot";
import { isIngestExecution } from "./status/model";
import type { DurableStorage } from "./storage";

const HOUR_MS = 60 * 60 * 1000;

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
  drainServer?: (then: () => Promise<void>) => Promise<void>;
}

/**
 * The one boot order for `main` and the acceptance stack: verify the schema fits the embedder, boot the
 * status model, hash the decoy, bind (when `listen` is given), and only then start recovery, the session
 * sweep and the upload sweeper (a failed bind must not spend recovery budget). A failure before that
 * cleans up what the caller opened and rethrows. `stop()` runs the shutdown in the order that keeps it
 * safe and is idempotent; it does not close what `bootIngest` did not open the caller's way
 * (the blob root, the temp dir, the test database).
 */
export async function bootIngest(
  parts: BootIngestParts,
): Promise<{ stop(): Promise<void>; recoveryIdle(): Promise<void> }> {
  const { built, ingest, durable, pool, listen, recoveryOwner, background = true } = parts;
  const {
    app,
    store,
    throttle,
    starts,
    status,
    activity,
    vectors,
    events,
    chatStreams,
    detachStatusFeed,
    chat,
    titles,
    eraser,
    erasureLocks,
  } = built;
  const cleanup = [
    () => closeIngest(ingest),
    () => app.close(),
    () => durable.close(),
    () => pool.end(),
  ];

  // The schema (applied out of band by `pnpm db:migrate`) must fit the embedder before anything else starts.
  await verifyVectors(vectors, cleanup);
  // Register, then catch up on what the log holds, before anything is served (ADR 0132 D13).
  await bootStatus(status, cleanup);
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

  let recovery!: ReturnType<typeof startRecovery>;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let uploadSweeper: ReturnType<typeof startSweeper> | undefined;
  const afterListen = () => {
    // Resume what the last process left running, then keep looking. Not awaited: the server must not wait to listen.
    recovery = startRecovery(app.runtime, durable.storage.eventStore, {
      // Ingest, and the chat: a conversation mid-turn at a crash, and an interrupted title flow (P5).
      owns: (id) => isIngestExecution(id) || isRecoverableChatExecution(id),
      // After the boot scan, a crash is found through its expired lease, not by reading every execution.
      ...(durable.storage.leaseStore && {
        leases: { store: durable.storage.leaseStore, owner: recoveryOwner },
      }),
    });
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
  };

  if (listen) {
    await bootServing({ bind: listen, cleanup: () => runAll(...cleanup), afterListen });
  } else {
    afterListen();
  }

  let stopping: Promise<void> | undefined;
  const stop = () => {
    // Timers first, then the open event streams (they never end on their own, so the server drain would
    // wait on them), then the server drain, then the close sequence.
    stopping ??= (async () => {
      if (sweepTimer) clearInterval(sweepTimer);
      recovery.stop();
      const sweeperStopped = uploadSweeper?.stop() ?? Promise.resolve(); // idempotent; no sweep may fire a start once the drain begins
      events.closeAll();
      chatStreams?.closeAll();
      const close = async () => {
        // Let a sweep that is already running finish.
        await drainWithin(sweeperStopped, SHUTDOWN_DRAIN_MS);
        // The server has stopped accepting uploads; let every fired flow start settle, then close everything.
        await runAll(
          ...closeSequence({
            ...(eraser && { stopErasure: () => eraser.stop() }),
            ...(erasureLocks && { closeErasureLocks: () => erasureLocks.end() }),
            startsIdle: async () => {
              await starts.idle();
              await titles?.idle();
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
            endPool: () => pool.end(),
          }),
        );
      };
      await (parts.drainServer ?? ((then) => then()))(close);
    })();
    return stopping;
  };
  return { stop, recoveryIdle: () => recovery.idle() };
}
